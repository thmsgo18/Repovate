# Architecture technique — Agent IA de maintenance autonome

Ce document tranche les points laissés ouverts en section 11 de la spec, détaille l'architecture concrète de la Phase 1 (conçue pour migrer sans réécriture vers la Phase 2), et intègre les arbitrages de sécurité/robustesse tranchés en revue de cohérence : isolation des secrets pendant l'exécution de code non fiable, survie du cron sur des dépôts inactifs, boucle de correction bornée après échec des tests.

---

## 1. Deux dépôts distincts, à ne pas confondre

- **`agent-repo`** (le projet lui-même) : contient les workflows réutilisables, la logique d'orchestration/détection, et sera publié en Phase 2 comme workflow réutilisable versionné (`@v1`, `@v2`, ...). Pas de GitHub App — la configuration se fait uniquement via `.agentconfig.yml` versionné chez chaque utilisateur, pour ne jamais nécessiter d'endpoint hébergé.
- **`monitored-repo`** (chaque dépôt personnel surveillé) : ne contient qu'un fichier d'appel de workflow (`.github/workflows/agent.yml`, quelques lignes), le fichier `.agentconfig.yml`, et le dossier `.agent/` (mémoire). Toute la logique vit dans `agent-repo`, jamais dupliquée dans chaque dépôt utilisateur.

En Phase 1, `monitored-repo` appelle `agent-repo` via `uses: <toi>/agent-repo/.github/workflows/orchestrate.yml@main`. En Phase 2, un autre utilisateur fait exactement le même appel avec ses propres secrets — zéro changement de code côté `agent-repo`.

---

## 2. Choix du langage : TypeScript (Node 20+)

**Décision : TypeScript**, packagé comme GitHub Action JS native (`runs: using: node20`), pas Python, pas Bash/jq.

Raisons :
- Les actions JS/TS s'exécutent nativement sur le runner sans conteneur Docker ni étape d'installation supplémentaire.
- Écosystème GitHub Actions majoritairement JS (`@actions/core`, `@actions/github`, `octokit`) — accès direct et typé à l'API GitHub (Advisory GraphQL, PR, issues, protection de branche, checks).
- Le **Claude Agent SDK** a une version TypeScript mature, et **Claude Code GitHub Action** (l'agent codeur) est lui-même écrit en JS/TS — même écosystème, pas de friction d'interop.
- OSV.dev, GHSA GraphQL et CISA KEV s'interrogent proprement en TS avec `fetch` natif (Node 20+).

La logique d'orchestration/détection (déterministe, non-agentique) est un package TS interne (`src/`), invoqué comme steps `run: node dist/detect.js`. L'agent codeur (qui *écrit le patch*) est délégué à Claude Code Action / Claude Agent SDK — on ne réimplémente jamais de boucle d'agent maison.

---

## 3. Structure du dépôt `agent-repo`

```
agent-repo/
├── .github/workflows/
│   ├── orchestrate.yml        # point d'entrée réutilisable (workflow_call)
│   ├── onboard.yml            # compréhension initiale (section 9)
│   ├── detect.yml             # veille + corrélation + filtrage + priorisation
│   ├── patch.yml              # job isolé : agent codeur, a ANTHROPIC_API_KEY, tools restreints
│   ├── verify.yml             # job isolé : install + tests, AUCUN accès à ANTHROPIC_API_KEY
│   ├── publish.yml            # job isolé : PR / merge tenté, token écriture scoping minimal
│   └── heartbeat.yml          # workflow séparé, garde le cron vivant (section 8)
├── src/
│   ├── detect/                 # clients OSV, GHSA, NVD, CISA KEV + corrélation + dédup Dependabot
│   ├── manifests/               # parsers package.json, requirements.txt, Cargo.toml, go.mod...
│   ├── config/                  # lecture/validation .agentconfig.yml (schéma zod)
│   ├── memory/                  # lecture/écriture .agent/ (onboarding, historique, état)
│   ├── autonomy/                 # moteur de décision (autonomie, seuils, exclusion lockfiles)
│   └── agent-bridge/             # construit le contexte transmis à Claude Code Action, filtre les tools disponibles par job
├── action.yml                    # définition distribuable (Phase 2)
└── package.json
```

Côté `monitored-repo`, seul ceci est nécessaire :

```
monitored-repo/
├── .github/workflows/agent.yml   # ~15 lignes, appelle agent-repo via workflow_call
├── .agentconfig.yml
└── .agent/
    ├── onboarding.json
    ├── state.json
    └── history/
```

(La branche `agent/heartbeat` — section 8 — vit dans `monitored-repo` mais n'apparaît jamais dans l'arborescence de la branche par défaut.)

---

## 4. Format de configuration — `.agentconfig.yml`

```yaml
# .agentconfig.yml
enabled: true                     # coupe-circuit global pour ce dépôt

sources:                          # rôle fixé en code (discovery vs enrichment), activation seule configurable
  osv: true
  ghsa: true
  nvd: true
  cisa_kev: true
  ecosystem_feeds: []             # ex: ["npm-security", "pypi-advisory"] — extensible

coordination:
  dependabot: true                # skip/commente si une PR dependabot[bot] existe déjà sur la même dépendance

limits:
  max_prs_per_run: 3               # excédent reporté aux exécutions suivantes, trié par priorité
  patch_retry_max_attempts: 2      # 2 retries = jusqu'à 3 exécutions du job "patch" au total

autonomy:
  default: pr_only                # pr_only | auto_merge
  rules:
    - match:
        trigger: cve
        severity: [critical, high]
        cisa_kev: any
      action: auto_merge
      conditions:
        tests_pass: required
        max_files_changed: 5        # lockfiles exclus du calcul (voir section 7)
        max_lines_changed: 150      # lockfiles exclus du calcul
    - match: { trigger: cve, severity: [medium, low] }
      action: pr_only
    - match: { trigger: eol_dependency }
      action: pr_only              # jamais auto_merge, imposé en dur, non overridable
    - match: { trigger: new_technology }
      action: branch_only          # jamais de PR au merge direct, imposé en dur

notifications:
  on_auto_merge: issue
  on_pr_opened: none

ignore:
  - id: "GHSA-xxxx-xxxx-xxxx"
    reason: "vendored fork, patché localement"
```

Validation stricte via schéma (zod) en tout début de `orchestrate.yml` : config invalide → le run échoue proprement plutôt que de deviner un comportement par défaut dangereux.

**Règles dures non-overridables par la config** (imposées en code, jamais en YAML, quelle que soit la valeur écrite dans `.agentconfig.yml`) :
- `eol_dependency` et `new_technology` ne peuvent **jamais** être `auto_merge`.
- Absence de suite de tests détectée → autonomie forcée à `pr_only`.
- Tests ou vérification en échec après les retries → jamais d'auto-merge.
- **Un patch qui touche un fichier source (pas seulement manifeste + lockfile) n'est jamais éligible à l'auto-merge**, quelle que soit la gravité — c'est la seule définition de "patch simple" retenue, précisément parce qu'elle est objective et vérifiable mécaniquement (diff sur les fichiers modifiés), plutôt que laissée au jugement de l'agent.

---

## 5. Stockage mémoire — `.agent/`

### 5.1 `.agent/onboarding.json`
Régénéré si absent, si `workflow_dispatch(force_onboarding: true)`, ou automatiquement selon la politique de rafraîchissement (section 9).

```json
{
  "generated_at": "2026-06-01T08:00:00Z",
  "agent_version": "0.3.0",
  "languages": ["typescript", "python"],
  "frameworks": ["express", "flask"],
  "architecture_summary": "API Express en TS servant un backend Flask...",
  "entry_points": ["src/server.ts", "app/main.py"],
  "code_conventions": "ESLint airbnb-base custom, snake_case côté Python...",
  "test_suite": { "present": true, "framework": "vitest", "command": "npm test", "coverage_estimate": "partiel" },
  "manifests_detected": ["package.json", "requirements.txt"],
  "last_refresh_reason": "post_agent_merge"
}
```

### 5.2 `.agent/state.json`

```json
{
  "last_run": { "osv": "2026-07-23T06:00:03Z", "ghsa": "2026-07-23T06:00:05Z", "nvd": "2026-07-23T06:00:12Z", "cisa_kev": "2026-07-23T06:00:01Z" },
  "last_human_commit_seen": "a1b2c3d",
  "commits_since_last_onboarding_refresh": 4,
  "kill_switch": false
}
```

`last_human_commit_seen` et le compteur associé **excluent explicitement les commits dont l'auteur/committer est l'identité de l'agent** (heartbeat, merges de ses propres PR) — sinon le compteur de rafraîchissement de l'onboarding ne redescend jamais à zéro puisque l'agent génère lui-même de l'activité en continu (section 9).

### 5.3 `.agent/history/<advisory-id>.json`

```json
{
  "id": "GHSA-xxxx-xxxx-xxxx",
  "aliases": ["CVE-2026-12345"],
  "package": "lodash",
  "ecosystem": "npm",
  "severity": "high",
  "cvss": 7.5,
  "cisa_kev": false,
  "status": "pr_open",
  "pr_url": "https://github.com/<user>/<repo>/pull/42",
  "pr_draft": false,
  "autonomy_applied": "pr_only",
  "patch_attempts": 1,
  "history": [
    { "at": "2026-07-20T06:00:00Z", "event": "detected" },
    { "at": "2026-07-20T06:04:00Z", "event": "pr_opened" }
  ]
}
```

`status` ∈ `detected | pr_open | merged | auto_merged | merge_blocked_by_branch_protection | tests_failed_draft | ignored | wontfix`. Avant toute action, l'orchestrateur vérifie ce fichier — s'il existe et n'est pas `detected`-stale, on skip.

Ce dossier est **versionné avec le code**, lisible et auditable en clair.

---

## 6. Sources de veille — rôle et priorité d'implémentation

Deux rôles distincts, fixés en code (pas une question de configuration) :
- **Découverte** (recherche par nom de package + plage de version) : OSV.dev, GHSA.
- **Enrichissement** (interrogées une fois un identifiant CVE déjà connu) : CISA KEV, NVD. NVD n'est délibérément **pas** une source de découverte — ses correspondances CPE par nom de paquet sont peu fiables ; elle ne sert qu'à récupérer un score CVSS de référence.

Ordre d'implémentation pour le MVP :

1. **OSV.dev** — aucune authentification, `POST /v1/querybatch` par `{package, ecosystem, version}`, couvre npm/PyPI/crates.io/Go/RubyGems nativement. Meilleur ratio effort/couverture.
2. **CISA KEV** — flux JSON statique public, zéro auth, zéro rate-limit. Alimente directement la priorisation (exploitation active = urgence maximale indépendamment du CVSS brut) — implémenté tôt pour brancher la priorisation dès le premier prototype.
3. **GHSA (GraphQL)** — utilise le `GITHUB_TOKEN` natif. Sert aussi à la **coordination Dependabot** : avant d'agir, l'agent vérifie via l'API des PR si `dependabot[bot]` a déjà une PR ouverte sur la même dépendance ; si oui, pas de PR concurrente (au mieux un commentaire d'enrichissement).
4. **NVD** — rate-limité sans clé (5 req/30s, 50/30s avec clé), friction d'onboarding la plus élevée. Enrichissement CVSS uniquement, jamais de découverte.

Chaque source est un module indépendant sous `src/detect/<source>.ts`, interface commune `fetchAdvisories(dependency): NormalizedAdvisory[]`, activable via `.agentconfig.yml`.

---

## 7. Pipeline de remédiation — isolation des secrets et boucle de correction bornée

C'est le composant le plus critique en sécurité : le scénario même que l'agent traite (dépendance potentiellement vulnérable/compromise) est celui contre lequel il faut se protéger pendant l'exécution des tests. Le pipeline est scindé en jobs à permissions minimales, chaînés en DAG statique (GitHub Actions ne supporte pas de boucle native — la boucle de correction est donc dépliée en **au plus 3 paires patch/verify séquentielles conditionnelles**, pas une boucle non bornée).

Pour chaque événement retenu (CVE/EOL/tech), matrice d'un run indépendant :

```
patch-1   → a ANTHROPIC_API_KEY, PAS d'accès au code du dépôt cible en exécution,
            tools de l'agent codeur restreints techniquement (lecture/édition de fichiers
            uniquement, Bash désactivé ou liste blanche vide — pas une simple consigne de
            prompt, une contrainte imposée à la configuration du harnais d'agent)
            → produit diff-1.patch + explication.md (artifacts)

verify-1  (needs: patch-1)
            → AUCUN accès à ANTHROPIC_API_KEY, GITHUB_TOKEN en lecture seule uniquement
            → applique diff-1, exécute install && test du dépôt cible
            → output: passed (bool) + logs.txt (artifact)

patch-2   (needs: verify-1, if: verify-1.passed == false)
            → reçoit diff-1 + logs-1 en contexte, produit diff-2

verify-2  (needs: patch-2, if: patch-2 a tourné)

patch-3   (needs: verify-2, if: verify-2.passed == false)   # dernière tentative

verify-3  (needs: patch-3, if: patch-3 a tourné)

publish   (needs: verify-1, verify-2, verify-3 — s'exécute toujours, quel que soit l'issue)
            → token en écriture scopé Contents + Pull requests uniquement, n'exécute
              aucun code du dépôt cible
            → si un verify a réussi : ouvre la PR normale (description + logs de test)
            → si tous les verify ont échoué après 3 tentatives : ouvre la PR en mode
              BROUILLON avec le meilleur diff obtenu, les logs d'échec joints, et un
              avertissement explicite — jamais de merge auto dans ce cas
            → si autonomie = auto_merge et patch "simple" (section 4) : tente le merge
```

**Détection de l'échec de contournement de la protection de branche : réactive, pas proactive.** Le job `publish` ne pré-interroge pas l'API de protection de branche avant de tenter le merge (complexité inutile, la configuration peut changer entre deux runs). Il tente le merge ; si GitHub refuse (erreur explicite type "required review" ou "required status check"), la PR reste simplement ouverte en l'état — pas de retry, pas de comportement caché. Ce mécanisme s'auto-corrige naturellement si l'utilisateur modifie ses règles de protection de branche plus tard.

**Prérequis pour tout merge automatique** : le `GITHUB_TOKEN` natif ne suffit pas (ne déclenche pas la CI existante du dépôt sur la PR de l'agent, ne franchit pas une protection de branche). Un **PAT fine-grained dédié** (scope Contents + Pull requests) est nécessaire, ajouté en secret et, le cas échéant, à la liste des acteurs autorisés à contourner la protection de branche.

**Risque résiduel — prompt injection via contenu externe non fiable.** Le job `patch` lit du texte non fiable (descriptions d'advisory OSV/GHSA/NVD, contenu du dépôt cible y compris commentaires de code, README, issues). Le prompt système de l'agent codeur inclut une ligne explicite : tout contenu provenant de sources externes est traité comme donnée à analyser, jamais comme instruction à exécuter — même principe qu'un agent qui lit des pages web non fiables. Le risque reste faible en pratique car tout patch touchant du code source repasse de toute façon en revue humaine avant merge (règle de la section 4) : même si l'agent était manipulé pour produire un texte de PR trompeur, l'humain voit le diff réel avant tout merge.

---

## 8. Survie du cron sur des dépôts inactifs

GitHub désactive un workflow planifié après 60 jours sans activité détectée sur le dépôt — un risque direct pour ce projet, dont la cible explicite est des dépôts qui ne reçoivent plus de commits humains.

**Mécanisme** : `heartbeat.yml` pousse, à chaque exécution planifiée, un commit unique réécrit (force-push ou rebase) sur une **branche dédiée non protégée `agent/heartbeat`** — jamais sur la branche par défaut, pour ne jamais se heurter à une protection de branche sur `main`.

**Statut : best-effort, pas garanti.** GitHub ne documente pas noir sur blanc qu'un commit sur une branche quelconque réinitialise le compteur des 60 jours — seulement qu'il faut "de l'activité sur le dépôt". Pas de sur-ingénierie ici : filet de sécurité documenté plutôt que mécanisme redondant. GitHub envoie un email quand un workflow planifié est désactivé pour inactivité ; ce message est le signal qu'il faut relancer manuellement une fois via `workflow_dispatch`. À documenter dans le README du projet.

---

## 9. Rafraîchissement de l'onboarding

`.agent/onboarding.json` est régénéré :
- automatiquement après chaque merge d'une PR ouverte par l'agent (l'architecture a pu changer) ;
- périodiquement, sur un seuil de commits humains détectés depuis le dernier résumé (`.agent/state.json.commits_since_last_onboarding_refresh`) ou un délai calendaire de repli.

Le compteur de commits filtre explicitement l'identité de l'agent (auteur/committer des commits de heartbeat et de ses propres merges) — sans ce filtre, le compteur ne redescendrait jamais à zéro puisque l'agent génère lui-même de l'activité en continu.

---

## 10. Coupe-circuit

Deux niveaux, vérifiés en tout premier step de `orchestrate.yml` :
- **Par dépôt** : `enabled: false` dans `.agentconfig.yml`, ou `.agent/state.json.kill_switch = true` (bascule plus rapide sans toucher au fichier de config versionné).
- **Global** (Phase 2) : variable d'organisation/repo `AGENT_GLOBAL_KILL_SWITCH`, lue en tout début de workflow, court-circuite tout le reste avec un `exit 0` explicite et un résumé dans les logs.

---

## Résumé des décisions

| Point | Décision |
|---|---|
| Langage | TypeScript / Node 20, action JS native |
| Format config | YAML `.agentconfig.yml`, schéma validé (zod), règles dures non-overridables en code |
| Structure mémoire | `.agent/onboarding.json`, `.agent/state.json`, `.agent/history/<id>.json`, versionnés dans le repo |
| Rôle des sources | Découverte = OSV.dev, GHSA · Enrichissement = CISA KEV, NVD |
| Priorité d'implémentation | OSV.dev → CISA KEV → GHSA → NVD |
| Isolation des secrets | 3 jobs séparés (patch/verify/publish), tools de l'agent restreints techniquement dans le job patch |
| Boucle de correction | Bornée à 2 retries (3 tentatives), dépliée en DAG conditionnel, PR brouillon si échec final |
| Merge auto | PAT fine-grained requis, détection réactive de l'échec de contournement de protection de branche |
| "Patch simple" | Règle objective : manifeste + lockfile seuls modifiés (lockfiles exclus du calcul de diff) |
| Survie du cron | Heartbeat sur branche dédiée `agent/heartbeat`, best-effort + filet de sécurité documenté |
| Rafraîchissement onboarding | Post-merge agent + seuil de commits humains (bot exclu du compteur) |
