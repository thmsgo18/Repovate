# Idées d'amélioration

Idées évoquées en discussion (avec Claude, entre nous, ou les deux) mais pas
encore décidées comme prochaine étape. Le but : garder une trace même quand
personne n'a pris de note sur le moment.

Pas besoin de suivre un format strict — une idée, deux phrases de contexte,
d'où elle vient si utile. Marquer `[fait]` ou supprimer l'entrée le jour où
elle est implémentée (et documentée dans `docs/status.md` à ce moment-là).

---

## Tableau de bord des vulnérabilités (« Dependency Dashboard »)

Une simple *issue* GitHub, créée ou mise à jour à chaque exécution planifiée,
récapitulant l'état de toutes les vulnérabilités en cours de traitement
(`.agent/history/` contient déjà toute l'info nécessaire). Inspiré de la
fonctionnalité équivalente de Renovate, repérée en comparant Repovate aux
outils concurrents. Ne viole pas la contrainte zéro serveur : un appel d'API
ponctuel par run, pas de service à faire tourner en continu. Semble avoir un
bon rapport effort/valeur par rapport aux autres pistes non commencées listées
dans `docs/status.md`.
