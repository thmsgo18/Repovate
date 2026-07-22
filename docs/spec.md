# Spécification projet — Agent IA de maintenance autonome pour dépôts GitHub

> Version finale, intégrant les corrections de cohérence discutées (survie du cron, isolation des secrets, coordination Dependabot, règle objective "patch simple", boucle de correction bornée, priorité des sources de veille).

## 1. Pitch / vision

Chaque développeur a des dépôts GitHub dont il est fier mais qu'il n'a pas touchés depuis des mois ou des années : dépendances obsolètes, failles de sécurité non corrigées, stack qui a vieilli. Ce projet est un **agent IA qui agit comme un collaborateur technique silencieux** sur l'ensemble des dépôts GitHub d'un développeur.

L'agent :
- lit chaque dépôt une première fois pour comprendre sa stack, son architecture et ses conventions de code,
- surveille ensuite en continu ce qui se passe dans l'écosystème technique (CVE, fins de vie de dépendances, nouvelles technologies pertinentes),
- réagit en écrivant lui-même le correctif adapté au style et à l'architecture du projet concerné, en vérifiant que les tests passent, et en ouvrant une Pull Request explicative,
- ne demande une validation humaine que quand c'est nécessaire — le reste est automatisé.

Différence avec Dependabot / Snyk / GitHub Copilot Autofix : ces outils bumpent des numéros de version ou proposent des correctifs génériques hors contexte. Cet agent lit vraiment le code, comprend son usage réel de la dépendance, et produit un patch cohérent avec la codebase — pas une modification générique.

## 2. Portée du projet (roadmap en deux phases)

**Phase 1 — MVP personnel**
- Usage : uniquement les dépôts GitHub de l'auteur du projet.
- Interface : un ou plusieurs workflows **GitHub Actions**, déclenchés sur planification (cron GitHub Actions, ex. toutes les 6h ou une fois par jour) et/ou manuellement via `workflow_dispatch`. Pas de script local à lancer à la main sur la durée, pas de serveur à héberger.
- Objectif : valider que tout le pipeline (détection → compréhension → patch → tests → PR) fonctionne de bout en bout sur de vrais dépôts, entièrement dans GitHub Actions.

**Phase 2 — Produit installable par d'autres**
- Packaging sous forme d'un **workflow GitHub Actions réutilisable** (`workflow_call`), distribué via un dépôt template. Aucune GitHub App, aucun endpoint web, même minimal — une GitHub App avec écran de configuration impliquerait un service à héberger, ce qui violerait la contrainte "zéro serveur" ci-dessous. La configuration se fait uniquement via un fichier YAML versionné dans le dépôt de chaque utilisateur.
- Aucune infrastructure hébergée par l'auteur du projet : tout tourne dans GitHub Actions, sur les runners fournis gratuitement par GitHub. Chaque utilisateur exécute l'agent dans son propre dépôt, avec ses propres quotas.
- Chaque utilisateur connecte sa propre clé API (Anthropic) via les secrets GitHub Actions de son dépôt et choisit les dépôts à surveiller.

**Contrainte explicite de conception : pas de serveur.** Le projet doit fonctionner intégralement sans aucun service tiers hébergé en continu (pas de Render, Fly.io, Railway, etc.). Toute la détection, l'orchestration et l'exécution doivent se faire via des workflows GitHub Actions déclenchés sur planification (cron) ou sur événements GitHub natifs (`workflow_dispatch`, `repository_dispatch`, événements de dépôt). C'est vrai dès la Phase 1 et reste vrai en Phase 2.

Le développement doit être architecturé dès la Phase 1 pour permettre cette transition vers la Phase 2 (pas de code jetable spécifique à un seul utilisateur codé en dur).

## 3. Les trois déclencheurs (fonctionnalités cœur)

### 3.1 Nouvelle CVE affectant une dépendance
1. Détection d'une CVE touchant une dépendance utilisée dans un dépôt surveillé.
2. L'agent lit le code du dépôt pour comprendre **comment** la dépendance vulnérable est utilisée (pas juste qu'elle est présente).
3. Il écrit un patch adapté à cet usage réel (pas un simple bump de version si un bump ne suffit pas, ou l'inverse : un simple bump si c'est suffisant).
4. Il exécute la suite de tests existante du projet pour vérifier qu'il ne casse rien.
5. Il ouvre une Pull Request contenant : la description de la vulnérabilité, l'explication du correctif, le résultat des tests.

### 3.2 Dépendance non maintenue / en fin de vie
1. Détection qu'une dépendance du projet est abandonnée ou en fin de vie officielle.
2. L'agent identifie la meilleure alternative moderne et compatible.
3. Il migre le code vers cette alternative.
4. Il ouvre une Pull Request avec un comparatif avant/après (ce qui change, pourquoi, risques éventuels).

### 3.3 Technologie mature à adopter
1. Détection qu'une technologie pertinente pour le projet a atteint une maturité suffisante pour être adoptée sans risque.
2. L'agent rédige une analyse des avantages/inconvénients pour ce projet précis.
3. Il implémente l'amélioration sur une branche dédiée (jamais directement proposée en merge automatique).
4. Il laisse le développeur décider.

## 4. Veille de sécurité — sources et fonctionnement

S'appuyer uniquement sur les alertes Dependabot de GitHub est insuffisant : Dependabot ne couvre pas tous les écosystèmes, a parfois du retard, et ne remonte que ce qui est déjà dans la base d'alertes GitHub. Le projet doit donc faire de la **veille active sur plusieurs sources externes**, pas seulement écouter passivement une seule API.

### 4.1 Sources à surveiller

- **GitHub Advisory Database** (API GraphQL/REST `security advisories`). Source de **découverte** (recherche par nom de package).
- **OSV.dev** (Open Source Vulnerabilities) — couvre npm, PyPI, crates.io, Go, RubyGems, etc. Source de **découverte** principale.
- **NVD (National Vulnerability Database)** — **pas une source de découverte** : ses correspondances CPE (paquet → CVE) sont peu fiables pour retrouver "quelles CVE affectent le package X version Y". Sert uniquement à **enrichir** une CVE déjà trouvée via GHSA/OSV (score CVSS de référence, description officielle).
- **CISA KEV (Known Exploited Vulnerabilities catalog)** — liste des vulnérabilités activement exploitées ; utile pour prioriser. Source d'**enrichissement**, interrogée par identifiant CVE une fois celui-ci connu.
- **Flux de sécurité spécifiques à un écosystème** quand ils existent (avis npm, PyPI, RubyGems, mailing-lists de sécurité de frameworks majeurs).

La liste exacte des sources actives doit être **configurable**.

### 4.2 Fonctionnement de la veille

1. **Extraction des dépendances** : dépendances directes (et transitives quand un lockfile est présent : `package-lock.json`, `poetry.lock`, `Cargo.lock`, etc.). **En l'absence de lockfile** (fréquent sur les vieux projets Python), l'agent se limite aux dépendances directes ; toute PR générée dans ce contexte doit l'indiquer explicitement ("dépendances transitives non vérifiées, aucun lockfile présent").
2. **Interrogation des sources** ciblée par nom de package et plage de versions — pas un scan générique du web.
3. **Corrélation et enrichissement** : une CVE trouvée via GitHub Advisory ou OSV est enrichie avec le score CVSS (NVD) et sa présence dans CISA KEV.
4. **Filtrage par pertinence réelle** : vérifier que la version vulnérable correspond à la version utilisée dans le projet.
5. **Priorisation** : gravité finale = CVSS combiné à la présence dans CISA KEV (exploitation active = priorité maximale, même si CVSS modéré).
6. **Déduplication dans le temps** : historique persistant par dépôt, une vulnérabilité déjà traitée ne redéclenche pas d'action.
7. **Coordination avec Dependabot natif** : avant d'agir, vérifier s'il existe déjà une PR `dependabot[bot]` sur la même dépendance. Si oui, pas de PR concurrente ; au mieux un commentaire d'enrichissement, ou laisser à Dependabot si le correctif est un simple bump.
8. **Limite de volume par exécution** : nombre de PR ouvertes plafonné par run (défaut configurable, ex. 3), triées par priorité décroissante. L'excédent est reporté aux exécutions suivantes.

### 4.3 Fréquence et implémentation

- Workflow GitHub Actions planifié (`schedule: cron`), fréquence configurable (ex. une fois par jour ou toutes les 6h).
- Toute la logique s'exécute dans ce workflow, sans service externe persistant.
- Run manuel possible via `workflow_dispatch`.

## 5. Phase d'onboarding sur un dépôt

- Identifier langages/frameworks, cartographier l'architecture, repérer les conventions de style, identifier la suite de tests (framework, commande, couverture approximative), produire un résumé structuré réutilisé à chaque intervention future.
- **Rafraîchissement** : régénéré (a) automatiquement après chaque merge d'une PR ouverte par l'agent, et (b) périodiquement même sans intervention de l'agent (ex. tous les X jours ou tous les N commits humains détectés depuis le dernier résumé).

## 6. Niveau d'autonomie — configurable selon la gravité

| Situation | Comportement par défaut |
|---|---|
| CVE critique/haute gravité, patch simple et tests passants | Merge automatique autorisé (si activé) |
| CVE gravité moyenne/faible | PR ouverte, validation humaine requise |
| Dépendance en fin de vie / migration | PR ouverte, jamais de merge auto |
| Suggestion de nouvelle technologie | Branche + PR informative uniquement, jamais de merge auto |

Exigences :
- Défini dans `.agentconfig.yml` à la racine de chaque dépôt.
- Jamais de merge automatique si les tests échouent, si la CI échoue, ou si le patch dépasse un seuil de fichiers/lignes configurable. **Les lockfiles sont exclus de ce calcul.**
- **Règle objective "patch simple" vs "patch adapté"** : un patch est "simple" (éligible au merge auto) s'il ne touche que le manifeste de dépendances et son lockfile. Dès qu'une ligne de code source est modifiée, le patch est "adapté" et **jamais éligible au merge automatique**, quelle que soit la gravité.
- **Prérequis technique** : le `GITHUB_TOKEN` par défaut ne suffit pas pour le merge auto (ne déclenche pas la CI existante, ne franchit pas une protection de branche). Nécessite un **PAT fine-grained dédié**. Si le token ne peut pas franchir la protection de branche, l'autonomie redescend automatiquement en PR-only.
- Toute action de merge automatique est tracée et notifiée, avec revert facile.

## 7. Architecture technique

**Principe directeur : tout tourne dans GitHub Actions, rien n'est hébergé en continu par l'auteur du projet.**

**Point de vigilance critique : la survie du cron.** GitHub désactive automatiquement un workflow planifié après 60 jours sans activité sur le dépôt. Le workflow de veille doit, à chaque exécution, écrire un commit "heartbeat" minimal sur une branche dédiée non protégée pour réinitialiser ce compteur (best-effort, non garanti par la documentation GitHub — filet de sécurité : email d'alerte GitHub + relance manuelle documentée).

### 7.1 Détection des événements
- CVE / dépendances vulnérables : workflow planifié interrogeant les sources de la section 4.
- Dépendances en fin de vie : combinaison de signaux — (a) date de dernière release au-delà d'un seuil (ex. 18-24 mois), (b) flag `deprecated` du registre, (c) statut "archived" du dépôt amont. Au moins deux signaux combinés avant de déclencher une action.
- Technologies matures à adopter : logique de veille plus ouverte, moins prioritaire, potentiellement Phase 2.

### 7.2 Orchestration
- Un workflow "orchestrateur" reçoit le résultat de la détection, consulte la configuration d'autonomie et l'historique, décide s'il déclenche une intervention et avec quel niveau d'autonomie, puis appelle l'agent codeur.

### 7.3 Compréhension du code et génération des patchs
- S'appuyer sur un agent codeur autonome existant (Claude Code GitHub Action / Claude Agent SDK) plutôt que réimplémenter une boucle d'agent.
- L'agent reçoit à chaque déclenchement : contexte de l'événement (CVE, dépendance, gravité) + résumé d'onboarding.

### 7.4 Exécution des tests

**Exigence de sécurité structurante : isolation stricte entre secrets et code non fiable.** `ANTHROPIC_API_KEY` et un token GitHub en écriture ne doivent jamais être accessibles dans le même job que celui qui exécute `install`/`test`/`build` du dépôt cible. Pipeline scindé en jobs séparés à permissions minimales :
- **Job "patch"** : accès à `ANTHROPIC_API_KEY`, n'exécute jamais le code du dépôt cible, produit un diff/patch en artifact. Les outils de l'agent codeur sont techniquement restreints à lecture/édition de fichiers (Bash désactivé) — contrainte de configuration du harnais, pas une simple consigne de prompt.
- **Job "vérification"** : reçoit le diff en artifact, aucun accès à `ANTHROPIC_API_KEY`, applique le patch et exécute `install && test` avec un token en lecture seule.
- **Job "publication"** : ne s'exécute que si la vérification est verte, token en écriture strictement limité à Contents + Pull requests, n'exécute aucun code du projet cible.

**Boucle de correction bornée** : si la vérification échoue, l'orchestrateur relance le job "patch" avec le diff précédent et les logs d'échec en contexte — maximum 2 retries (3 tentatives au total). Après 2 échecs consécutifs, ouverture automatique d'une PR en mode brouillon avec le meilleur patch obtenu, les logs joints, et un avertissement explicite — jamais de merge auto dans ce cas, jamais de boucle non bornée.

- Absence de tests existants → autonomie forcée au minimum (PR uniquement).
- **Toolchains obsolètes** : si le langage/version n'est plus disponible nativement sur les runners hébergés, exécution dans un conteneur Docker épinglé à cette version. Si même cette approche échoue, repli automatique en PR-only avec mention explicite que la validité n'a pas pu être vérifiée par les tests.

### 7.5 Stockage et mémoire
- Mémoire par dépôt stockée dans le dépôt lui-même (`.agent/` versionné) : résumé de compréhension, historique des interventions, configuration d'autonomie.

### 7.6 Interaction avec GitHub
- Le `GITHUB_TOKEN` par défaut suffit pour la détection et l'ouverture de PR simples, mais pas pour le merge automatique ni pour déclencher la CI existante du dépôt sur la PR de l'agent (limitation native de GitHub Actions). Pour le merge automatique, un **PAT fine-grained dédié** est nécessaire.
- Phase 1 : `GITHUB_TOKEN` natif pour détection/PR ; PAT dédié optionnel si merge auto activé.
- Phase 2 : workflow réutilisable distribuable, chaque utilisateur l'appelle avec ses propres secrets.

## 8. Exigences de sécurité

- Ne jamais exposer ou logger les clés API/tokens en clair.
- **Isolation stricte entre secrets sensibles et exécution de code non fiable** (voir 7.4) : c'est le point de sécurité le plus structurant du projet, précisément parce que le scénario traité par l'agent (dépendance potentiellement compromise) est celui contre lequel cette isolation protège.
- Aucune action destructrice irréversible sans validation humaine (pas de force-push, pas de suppression de branches/tags, pas de modification de secrets ou de settings du repo).
- Le merge automatique doit être une fonctionnalité opt-in explicite, jamais un comportement par défaut activé silencieusement.
- Toute PR ouverte par l'agent doit être clairement identifiable comme générée par un agent (label, préfixe de titre, signature dans la description).
- Prompt système de l'agent codeur : tout contenu externe (advisories, contenu du dépôt cible) est traité comme donnée, jamais comme instruction — protection contre la prompt injection.
- Prévoir un mécanisme de "coupe-circuit" : une commande ou un réglage qui désactive instantanément l'agent sur un dépôt ou globalement.

## 9. Hors périmètre

- Pas de fonctionnalité de gestion de projet plus large (pas de triage d'issues générales, pas de revue de code sur les PR humaines).
- Pas de facturation / modèle économique à ce stade.
- Pas d'interface web ni de dashboard dédié ; interaction exclusivement via GitHub (Actions, issues, PR, notifications).
- Pas de serveur ni de service hébergé en continu, à aucune phase du projet.
- Pas de GitHub App avec interface de configuration (impliquerait un endpoint hébergé, contradictoire avec la contrainte "zéro serveur").

## 10. Critères de succès du MVP (Phase 1)

1. L'agent produit un résumé de compréhension pertinent et correct du dépôt.
2. Face à une CVE réelle ou simulée, l'agent propose un patch qui compile/passe les tests existants (ou indique clairement qu'il ne peut pas garantir la validité en l'absence de tests).
3. La Pull Request générée est lisible, correctement expliquée, jugée comme "un patch qu'un humain aurait pu écrire".
4. Le comportement d'autonomie configurable (merge auto vs PR) fonctionne comme attendu.

## 11. Décisions tranchées pour l'implémentation

Voir [architecture.md](architecture.md) pour le détail complet. Résumé :

| Point | Décision |
|---|---|
| Langage | TypeScript / Node 20, action JS native |
| Format config | YAML `.agentconfig.yml`, schéma validé (zod), règles dures non-overridables en code |
| Structure mémoire | `.agent/onboarding.json`, `.agent/state.json`, `.agent/history/<id>.json`, versionnés dans le repo |
| Rôle des sources | Découverte = OSV.dev, GHSA · Enrichissement = CISA KEV, NVD |
| Priorité d'implémentation | OSV.dev → CISA KEV → GHSA → NVD |
| Isolation des secrets | 3 jobs séparés (patch/verify/publish), tools de l'agent restreints techniquement |
| Boucle de correction | Bornée à 2 retries (3 tentatives), DAG conditionnel, PR brouillon si échec final |
| Merge auto | PAT fine-grained requis, détection réactive de blocage par protection de branche |
| Survie du cron | Heartbeat sur branche dédiée `agent/heartbeat`, best-effort + filet de sécurité documenté |

## 12. Nom du projet

**Repovate** — retenu après recherche de disponibilité GitHub.
