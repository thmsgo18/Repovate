# Repovate

Agent IA de maintenance autonome pour dépôts GitHub — un collaborateur technique silencieux qui lit tes dépôts, surveille l'écosystème (CVE, dépendances en fin de vie, nouvelles technologies), écrit lui-même les correctifs adaptés au style du projet, vérifie que les tests passent, et ouvre des Pull Requests. Tout tourne dans GitHub Actions — aucun serveur, aucune infrastructure hébergée en continu.

## Documentation

- [`docs/spec.md`](docs/spec.md) — spécification fonctionnelle complète (pitch, phases, déclencheurs, veille de sécurité, autonomie, sécurité).
- [`docs/architecture.md`](docs/architecture.md) — décisions techniques d'implémentation (langage, format de config, structure de mémoire, pipeline de workflows, isolation des secrets).

## État du projet

Phase de conception terminée — spécification et architecture cohérentes et arbitrées. Implémentation pas encore démarrée. Voir le plan d'action en fin de [`docs/architecture.md`](docs/architecture.md) pour la séquence de développement prévue (scaffold → squelette fonctionnel sur un dépôt réel → durcissement du pipeline → élargissement de la détection → autonomie complète).

## Contrainte de conception

Zéro serveur, à toutes les phases : tout s'exécute via des workflows GitHub Actions (`schedule`, `workflow_dispatch`, `workflow_call`), sur les runners fournis gratuitement par GitHub.
