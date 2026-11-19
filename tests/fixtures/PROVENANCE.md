# Test fixtures — provenance

| file | what | source | licence / terms |
|---|---|---|---|
| `starlink-sample.omm.json` (99 KB, sha256 `f2d1bef2…388f`) | 234 public GP element sets (OMM JSON): 233 Starlink satellites and the ISS, epochs 2026-11-16 to 2026-11-18; used by `src/engine/satellites.test.ts` and `npm run smoke:sky` | CelesTrak, https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=json (plus the ISS, catalogue number 25544, from CelesTrak's GP data), downloaded 2026-11-18, trimmed to a sample; CelesTrak publishes the US Space Force's public GP data from space-track.org | public orbital data, redistributed unchanged as a sample; no endorsement by CelesTrak or the US Space Force |
