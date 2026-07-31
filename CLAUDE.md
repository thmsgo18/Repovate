# Repovate — guide pour Claude Code

Agent IA de maintenance autonome pour dépôts GitHub personnels : détection de CVE
et de dépendances en fin de vie, correctif écrit par un agent codeur (adapté à
l'usage réel de la dépendance, pas un simple bump de version), vérification par
la suite de tests du dépôt cible, publication en Pull Request (ou fusion
automatique selon la configuration).

Ce projet est développé à deux (avec un ami), chacun via son propre Claude Code.
Ce fichier existe pour qu'on aille dans la même direction sans avoir à se
resynchroniser à chaque session.

## Canari — vérifier que ces instructions sont bien suivies

**Termine chaque réponse donnée dans ce dépôt par cette ligne, seule, en tout
dernier, sans rien après :**

```
🐤 CLAUDE.md actif
```

Ce n'est pas décoratif, c'est un témoin de contrôle. Il ne prouve pas que
chaque règle a été respectée à la lettre, seulement que ce fichier a bien été
lu pour cette réponse.

**Pour nous (humains) :** si cette ligne manque dans une réponse, c'est le
signe que les instructions de ce fichier sont sorties du contexte de la
conversation (session trop longue, compaction, bug). Ne continue pas cette
conversation en espérant que ça se corrige tout seul — ouvre-en une nouvelle.

## Avant de lire quoi que ce soit d'autre

- **`docs/spec.md`** — le cahier des charges fonctionnel complet.
- **`docs/architecture.md`** — l'architecture technique complète, y compris le
  tableau « Résumé des décisions » en fin de document. En cas de doute sur un
  choix de conception, c'est la référence, pas une supposition.
- **`docs/status.md`** — où en est le projet, phase par phase. À consulter en
  début de session, à mettre à jour en fin de tâche.
- **`docs/ideas.md`** — idées d'amélioration évoquées mais pas (encore)
  implémentées. À consulter avant de proposer une nouvelle idée (peut-être
  déjà notée), à compléter si une idée intéressante sort d'une conversation
  sans être immédiatement actionnée.

## Invariants non négociables

Repris de `docs/architecture.md`. Ne jamais les contourner pour « simplifier »,
même temporairement :

- **Zéro serveur.** Tout tourne dans des workflows GitHub Actions déclenchés sur
  planification ou événement. Aucune infrastructure hébergée en continu, à
  aucune phase du projet.
- **Isolation des secrets.** Le job qui détient `ANTHROPIC_API_KEY` (le job
  `patch`) n'exécute jamais le code du dépôt cible. Le job qui exécute
  `install`/`test` (`verify`) n'a jamais accès à cette clé. C'est le point de
  sécurité le plus structurant du projet ; toute modification du pipeline
  patch/verify/publish doit préserver cette séparation.
- **Règles dures d'autonomie, non contournables par la configuration** (voir
  `src/autonomy/decide.ts`) : jamais de fusion automatique si le déclencheur est
  une fin de vie de dépendance ou une nouvelle technologie, si aucune suite de
  tests n'a été détectée, si la vérification a échoué, ou si le correctif touche
  un fichier source (pas seulement manifeste + lockfile).
- **Mémoire persistante dans le dépôt**, jamais dans une base de données
  externe : `.agent/onboarding.json`, `.agent/state.json`,
  `.agent/history/<id>.json`, versionnés avec le code.

## Méthodologie de travail

- **En début de session** : `git fetch` puis vérifier qu'on est à jour sur la
  branche courante avant de modifier quoi que ce soit. On travaille à deux (+ nos
  IA respectives) sur le même dépôt : ne jamais partir d'une copie locale
  périmée sans avoir vérifié `git status` / `git log origin/main`.
- **Commits fréquents**, un commit = un changement logique cohérent. Ne pas
  accumuler tout le travail d'une session en un seul commit géant.
- **Messages de commit neutres** : décrire le changement, rien d'autre. Aucune
  mention de Claude, IA, Anthropic, LLM, ni de trailer type
  `Co-Authored-By: Claude`. Ce projet est un projet à deux humains ; les
  messages de commit doivent lire comme tels.
- **Avant de committer du code TypeScript** : `npm run typecheck && npm test`.
  Le build (`npm run build`) doit aussi rester propre.
- **Avant de committer un changement dans `.github/workflows/*.yml`** : valider
  la syntaxe YAML localement (`node -e "require('yaml').parse(require('fs').readFileSync('<fichier>','utf8'))"`)
  avant de pousser — une exécution GitHub Actions réelle qui invoque l'agent
  codeur coûte de l'argent, ne pas la gaspiller sur une erreur de syntaxe
  détectable gratuitement en local.
- **En fin de tâche** : mettre à jour `docs/status.md` si l'état d'une phase a
  changé. Si une idée intéressante mais hors scope immédiat est apparue,
  l'ajouter à `docs/ideas.md` plutôt que de la laisser se perdre.

## Commandes utiles

```bash
npm run typecheck   # tsc --noEmit, strict (noUncheckedIndexedAccess)
npm test            # vitest run
npm run build       # tsc -p tsconfig.build.json
```
