# État d'avancement

Statut à jour au 28 juillet 2026. À mettre à jour en fin de tâche (voir
`CLAUDE.md`) — ce fichier n'a de valeur que s'il reflète l'état réel du dépôt,
pas l'état espéré.

Légende : ✅ Terminé · 🚧 En cours / partiel · ⬜ Pas commencé

## Phase 0 — Fondations

✅ **Terminé.** Squelette du projet (`package.json`, `tsconfig`, `action.yml`),
schéma `.agentconfig.yml` validé par `zod` (`src/config/`), lecture/écriture de
la mémoire persistante `.agent/` (`src/memory/`). Tests unitaires en place dès
cette phase.

## Phase 1 — Pipeline minimal

✅ **Terminé.** Onboarding (analyse initiale d'un dépôt par l'agent codeur,
`onboard.yml`), détection npm via OSV.dev, premier squelette
patch/test/PR à un seul job. Validé en conditions réelles sur les dépôts
`VoltPoint` et `Neurovent`.

## Phase 2 — Isolation et robustesse

✅ **Terminé.** Pipeline scindé en jobs isolés `patch` / `verify` / `publish`
(`attempt.yml`, `remediate.yml`), boucle de correction bornée à 3 tentatives,
heartbeat pour éviter la désactivation du cron GitHub après 60 jours
d'inactivité. Validé en conditions réelles (cas nodemailer sur Neurovent, voir
`docs/architecture.md` / le rapport).

## Phase 3 — Veille élargie

✅ **Terminé.**
- Sources GHSA + CISA KEV + NVD, corrélation/déduplication (`src/detect/`).
- Deuxième écosystème : Python / `requirements.txt` (`src/manifests/python.ts`).
- Heuristiques de fin de vie (EOL), au moins deux signaux requis sur trois
  (`src/detect/eol.ts`), validées sur des paquets réels (`request` npm,
  `django` PyPI).

## Phase 4 — Autonomie complète

🚧 **En cours — code terminé et testé unitairement, jamais validé en
conditions réelles.**
- Moteur de décision d'autonomie (`src/autonomy/decide.ts`) : règles de
  configuration, conditions par règle, règles dures non contournables. Testé.
- Classification objective du « patch simple » (`src/autonomy/diff.ts`). Testé.
- Tentative de fusion automatique câblée dans `remediate.yml` (détection
  réactive du blocage par protection de branche, secret `repovate_pat`
  optionnel). Testé unitairement, **jamais exercé en live** (aucun run réel
  avec un vrai PAT configuré qui aurait effectivement tenté une fusion).
- Écriture de l'historique `.agent/history/<id>.json` à chaque étape du
  pipeline. Testé.

**Prochaine étape concrète pour clore la phase :** configurer un
`repovate_pat` sur un dépôt de test et déclencher un run réel jusqu'au bout
pour observer le comportement de fusion automatique (ou son rejet par une
protection de branche) en conditions réelles.

## Non commencé

- **Migration automatique des dépendances en fin de vie.** La détection EOL
  (Phase 3) est terminée ; identifier une alternative et migrer le code vers
  elle n'est pas implémenté. Réutiliserait directement le pipeline
  patch/verify/publish existant.
- **Détection de nouvelle technologie mature.** Le moteur de décision gère déjà
  ce cas (jamais de fusion auto, branche uniquement) mais aucune source de
  détection n'existe.
- **Toolchains obsolètes** (Node 10, Python 2...) via conteneur Docker épinglé
  pour le job `verify`. Cas non rencontré sur les dépôts réels utilisés jusqu'ici.
- **Phase 2 du cahier des charges** : packaging de Repovate en `workflow_call`
  réutilisable par un dépôt tiers (sa propre clé d'API, ses propres dépôts).
  Aucune réécriture architecturale nécessaire a priori, mais jamais exercé
  avec un appelant externe réel.

Voir aussi `docs/ideas.md` pour les pistes évoquées mais pas encore évaluées
comme prochaine étape.
