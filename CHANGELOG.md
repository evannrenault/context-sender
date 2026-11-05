# Changelog

## 1.2.0
- Nettoyage automatique des exports (fichier à joindre, fichiers séparés) après 24 h par défaut (réglage exportRetentionHours, 0 = jamais) : au démarrage, toutes les heures et avant chaque export
- Bouton « 🧹 Supprimer les exports » et commande associée pour tout effacer immédiatement
- Seuls les exports créés par l'extension (nom horodaté, .txt / .md ou dossier) sont supprimés, même dans un dossier d'export personnalisé

## 1.1.0
- Appliquer la réponse de l'IA (bouton 📥 ou Ctrl+Alt+V) : lecture de la réponse copiée, fichier par fichier (« ### Fichier : … », **chemin**, ```go:chemin, // Fichier : … en 1re ligne), fichiers complets ou zones diff (format git ou format de l'extension), revue avec diff avant / après, appliquer / ignorer / choisir la cible, tout appliquer, annuler (fichier ou tout, fichiers créés supprimés)
- Applicateur de diff tolérant : numéros de ligne approximatifs, espaces / tabulations, espace de contexte oublié, fins de ligne Windows conservées
- Option « Demander une réponse applicable » : ajoute à la consigne le format de réponse attendu
- Arborescence ordonnée comme l'Explorateur, fichier ouvert surligné et révélé automatiquement, bouton « ◉ Actif »
- Correctif : dossier affiché à tort pour les fichiers à la racine dans la vue filtrée

## 1.0.0
- Panneau latéral : arborescence avec cases à cocher, listes déroulantes Projets / Types, filtre texte
- Détection des projets par dépôts git (imbriqués compris) et fichiers marqueurs
- Ajout rapide des fichiers modifiés (git) et des onglets ouverts, selon les filtres
- Mode « Modifs seules » (diff git lisible avec contexte réglable) et estimation réelle des tokens
- Envoi : collage direct, fichier à joindre, découpage en plusieurs messages, fichiers séparés
- Exclusions globales (réglage) et par projet, masquage des secrets, sélections enregistrées
- Nom et URL du chat configurables, aucun service par défaut
- Interface responsive pour une barre latérale étroite
