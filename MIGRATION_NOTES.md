# Migration vers Docsify (Marked) — Notes

Objectif : supprimer la syntaxe Wikidot/Obsidian non supportée par Marked (Docsify) et normaliser les liens en chemins relatifs.

## Règles appliquées

### Liens internes (Obsidian)
```text
[[page]] -> [page](page.md)                       (si la cible est un fichier Markdown du même dossier)
[[page|libellé]] / [[page | libellé]] -> [libellé](page.md)
[[../dossier/page|libellé]] -> [libellé](../dossier/page.md)
```

### Images (Obsidian)
```text
![[../img/Fichier.jpg|1346]] -> <img src="../img/Fichier.jpg" width="1346" />
![[Fichier.jpg|]] -> ![](Fichier.jpg)            (puis déplacement/normalisation si l’image est ailleurs)
```

### Macros Wikidot
```text
[[div ...]]...[[/div]] -> <div ...>...</div>
[[iframe ...]]...[[/iframe]] -> <iframe ...>...</iframe>
[[span ...]]...[[/span]] -> <span ...>...</span>
[[size smaller]]...[[/size]] -> <small>...</small>
[[module Comments]] -> supprimé (non supporté)
[[toc]] / [[f>toc]] -> supprimé (pas de TOC Marked natif)
[[button print ...]] -> supprimé
```

### Notes / footnotes
`[[footnote]]...[[/footnote]]` : Marked ne supporte pas les notes de bas de page nativement.
  - Conversion cible : note inline (ex. `*(Note : ...)*`) ou phrase entre parenthèses.
`[[footnoteblock ...]]` : supprimé.

### Liens externes Wikidot
```text
[http://example.com Label] -> [Label](http://example.com)
http:*en.wikipedia.org/... -> http://en.wikipedia.org/...
```

## Difficultés / points à vérifier
- De nombreux liens `http://villamanlia.wikidot.com/...` pointent vers l’ancien site : ils doivent être remplacés par des liens relatifs vers les fichiers locaux quand ils correspondent.
- Les ancres `#...` issues de Wikidot ne correspondent pas forcément aux ancres générées par Marked/Docsify.
- Plusieurs images référencées via `![[...]]` ne semblent pas présentes dans `img/` : il faut retrouver leur emplacement ou corriger les références.
- Certains liens internes pointent vers des pages/diagrammes qui ne sont pas présents dans le dépôt (ex. « plan de table », schémas) : en attendant, ils sont remplacés par une mention explicite « non inclus dans ce dépôt ».

## À faire
- Conversion progressive par lots (navigation → ressources → scénarios → saga → personnages).
- Scan final pour s’assurer qu’il ne reste plus de `[[...]]` (hors blocs de code) et que tous les liens relatifs pointent vers des fichiers existants.

## Automatisation (script Node.js)

Un script est disponible pour appliquer automatiquement les règles « mécaniques » (suppression de macros Wikidot, conversion de wikilinks Obsidian, etc.) de manière **prudente**.

- Script : [scripts/migrate-markdown.js](scripts/migrate-markdown.js)
- Sécurité :
  - **dry-run par défaut** (aucune écriture)
  - option `--write` pour appliquer
  - **backups horodatés** dans `.migration-backups/` (désactivables via `--no-backup`)
  - écriture **atomique** (temp file puis rename)

Commandes recommandées :

- Dry-run global avec rapport JSON :
  - `node scripts/migrate-markdown.js --report .migration-report.json`
- Appliquer sur tout le dépôt (avec backups) :
  - `node scripts/migrate-markdown.js --write --report .migration-report.json`
- Appliquer par lot (ex. scénarios uniquement) :
  - `node scripts/migrate-markdown.js --write --include scenar/ --report .migration-report.json`

Limites connues :

- Les blocs de code (fences ```...```) ne sont pas modifiés.
- Les ancres Wikidot (`#toc...`) sont en pratique instables : pour les liens `villamanlia.wikidot.com/...`, le script privilégie des liens `.md` **sans ancre**.
- Les liens Wikidot ne sont réécrits en `.md` que si la cible est **résolue de manière unique** dans l’arborescence (sinon, le lien est laissé tel quel et signalé dans le rapport).
