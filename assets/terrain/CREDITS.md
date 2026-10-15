# Climb assets: sources and licences

## Poly Haven (CC0 1.0, no attribution required; credit is courtesy)
Licence: https://polyhaven.com/license   Files listed by https://api.polyhaven.com/files/<id>, fetched from dl.polyhaven.org.

| Asset | Files | Page |
|---|---|---|
| rock_face_03 (texture, 2K JPG) | `rock_face_03_{diff,nor_gl,arm}_2k.jpg` | https://polyhaven.com/a/rock_face_03 |
| lichen_rock (texture, 2K JPG) | `lichen_rock_{diff,nor_gl,arm}_2k.jpg` | https://polyhaven.com/a/lichen_rock |
| rocky_terrain_03 (texture, 2K JPG) | `rocky_terrain_03_{diff,nor_gl,arm}_2k.jpg` | https://polyhaven.com/a/rocky_terrain_03 |
| boulder_01 (model, glTF 1K) | `models/boulder_01/` | https://polyhaven.com/a/boulder_01 |
| rock_face_01 (model, glTF 1K) | `models/rock_face_01/` | https://polyhaven.com/a/rock_face_01 |
| shrub_03 (model, glTF 1K) | `models/shrub_03/` | https://polyhaven.com/a/shrub_03 |

Every file was checked against the MD5 the API lists.

## Copernicus DEM GLO-30
Source: AWS open-data bucket `copernicus-dem-30m` (https://copernicus-dem-30m.s3.amazonaws.com/), tiles
`Copernicus_DSM_COG_10_N{35,36,37}_00_E{073,074,075}_00_DEM` (N37 E073 not fetched; outside the crop). Originals in `dem/raw/`.
Licence: free for the general public under the Copernicus DEM licence
(https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model, as linked from the bucket's `readme.html`).
Derived file: `hunza_cop30_n36e074.png` (+ `.json`), a cropped, bilinear-downsampled 16-bit heightmap.

Credit line (to show in the page footer):

> Contains modified Copernicus DEM data © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA; all rights reserved

Note: the bucket's readme only points to the licence and does not itself quote this wording; the line above is the one
supplied for the project. The licence page is outside the allowed download hosts, so its exact wording is NOT verified here.
