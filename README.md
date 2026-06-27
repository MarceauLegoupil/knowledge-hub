# Knowledge Hub

Knowledge Hub transforme automatiquement une playlist YouTube en base de connaissances statique pour GitHub Pages. La page affiche uniquement des idees reformulees, classees et lisibles en francais. Les transcriptions completes ne sont jamais stockees dans `data.json`.

## Architecture

```text
.
|-- index.html
|-- style.css
|-- script.js
|-- data.json
|-- config.json
|-- config.example.json
|-- package.json
|-- scripts/
|   |-- generate-data.js
|   |-- validate-data.js
|   `-- serve-static.js
`-- .github/
    `-- workflows/
        `-- update-knowledge-hub.yml
```

## Fonctionnement automatique

Le fichier `.github/workflows/update-knowledge-hub.yml` lance une mise a jour toutes les heures.

Le workflow:

- lit la playlist configuree dans `config.json`;
- detecte les videos deja analysees dans `data.json`;
- reutilise les anciennes cartes pour eviter de retraiter toute la playlist;
- analyse uniquement les nouvelles videos ou les videos forcees;
- recupere les transcriptions disponibles en francais ou en anglais;
- transforme les transcriptions anglaises en idees reformulees en francais;
- valide que `data.json` ne contient aucune transcription brute;
- commit automatiquement `data.json` si le contenu a change.

GitHub Pages ne peut pas recevoir un evenement direct quand vous ajoutez une video YouTube. Le workflow fait donc une verification automatique toutes les heures. Vous pouvez aussi le lancer manuellement depuis l'onglet `Actions`.

## Configuration requise pour GitHub Actions

Dans votre depot GitHub:

1. Ouvrez `Settings`.
2. Allez dans `Secrets and variables` puis `Actions`.
3. Ajoutez un secret nomme `OPENAI_API_KEY`.
4. Optionnellement, ajoutez une variable `OPENAI_MODEL` si vous voulez changer le modele.

La traduction anglais vers francais et la reformulation professionnelle exigent une cle OpenAI. Avec la configuration par defaut, le script echoue volontairement si la cle est absente afin d'eviter une base incomplete.

## Ajouter ou modifier la playlist

Modifiez `config.json`:

```json
{
  "playlist_url": "https://youtube.com/playlist?list=VOTRE_PLAYLIST_ID",
  "transcript_languages": ["fr", "en"],
  "max_videos": 0,
  "max_items_per_video": 5,
  "analyzer": "openai",
  "target_language": "fr",
  "require_ai_translation": true
}
```

`max_videos: 0` signifie que toutes les videos disponibles de la playlist sont prises en compte.

## Lancer localement

Installation:

```bash
npm install
```

Sous Windows PowerShell, si `npm` est bloque par la politique d'execution:

```powershell
npm.cmd install
```

Ajoutez un fichier `.env` local non versionne:

```bash
OPENAI_API_KEY=votre_cle
OPENAI_MODEL=gpt-4.1-mini
```

Analyse + validation:

```bash
npm run update
```

Sous PowerShell:

```powershell
npm.cmd run update
```

Forcer la regeneration de toutes les videos deja analysees:

```bash
npm run analyze -- --force
```

## Consulter la page

En local:

```bash
npm run dev
```

Ouvrez ensuite `http://127.0.0.1:5173`.

La page GitHub Pages lit `data.json`, affiche les cartes, propose une barre de recherche, des filtres par categorie et un lien vers chaque video source.

## Deployer sur GitHub Pages

1. Poussez ces fichiers a la racine du depot GitHub.
2. Ouvrez `Settings` puis `Pages`.
3. Choisissez `Deploy from a branch`.
4. Selectionnez la branche `main` et le dossier `/root`.
5. Activez le secret `OPENAI_API_KEY`.
6. Le workflow mettra `data.json` a jour automatiquement quand de nouvelles videos seront detectees.

## Garanties

- Aucune transcription complete n'est publiee.
- Les videos en anglais sont restituees en francais.
- Les longues citations et copies mot pour mot sont evitees.
- Les videos sans transcription exploitable sont signalees dans `metadata.errors`.
- Les videos deja analysees sont reutilisees pour limiter le cout et accelerer les mises a jour.
