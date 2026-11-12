'use strict';

import { spawn } from 'child_process';
import { createReadStream, createWriteStream, promises as fsp } from 'fs';
import { get as httpGet, IncomingMessage } from 'http';
import { get as httpsGet } from 'https';
import { Context, Errors } from 'moleculer';
import { tmpdir } from 'os';
import { join } from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';

// The endpoints are unauthenticated and a ~137-byte layer costs one GDAL
// process, so a 25MB body could ask for ~180k sequential ogr2ogr spawns.
export const MAX_LAYERS = 32;
// One VRT column per field, and the DBF/GDB ceiling is 255 anyway.
export const MAX_FIELDS = 255;
export const MAX_TOTAL_FEATURES = 500_000;

// The `type` member has to fall inside this window, which the writer on the other side puts first.
const SOURCE_HEAD_BYTES = 512;
// Idle, not total: a legitimately slow download must not be cut, but a socket that stops moving bytes has to let go.
const DEFAULT_SOURCE_IDLE_MS = 2 * 60 * 1000;
// A url layer is never parsed, so bytes on disk are the only countable limit.
const DEFAULT_MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;

function maxSourceBytes(): number {
  return Number(process.env.VECTOR_EXPORT_MAX_SOURCE_BYTES) || DEFAULT_MAX_SOURCE_BYTES;
}

// Fail closed: an unconfigured deployment fetches nothing and stays inline-only.
function allowedSourceHosts(): string[] {
  return (process.env.VECTOR_EXPORT_SOURCE_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

// These bound an abandoned DOWNLOAD; a conversion of real size is never cut short.
export const DOWNLOAD_IDLE_SWEEP_MS = 4 * 60 * 1000;
// A trickling client keeps the progress check happy forever, so the download gets a ceiling of its own.
export const DOWNLOAD_MAX_MS = 4 * DOWNLOAD_IDLE_SWEEP_MS;

// GDAL emits one warning per feature for common cases (e.g. MultiPolygon
// features into a Polygon layer), so an uncapped stderr buffer grows with
// feature count even on success.
const MAX_STDERR_CHARS = 64 * 1024;

export interface VectorExportField {
  name: string;
  // Name to use where the driver caps field names (Shapefile: 10 chars).
  shortName?: string;
  alias?: string;
  type?: string;
}

// Only the two members the pipeline reads; the body is validated at runtime
// and written out verbatim.
export interface VectorExportFeatureCollection {
  type?: string;
  features?: unknown[];
}

export interface VectorExportLayer {
  name: string;
  // Exactly one of the two: an inline collection, or a url to fetch it from.
  geojson?: VectorExportFeatureCollection;
  url?: string;
  fields?: VectorExportField[];
}

// `packaging`: GDB and Shapefile produce a directory to zip, GPKG one file.
// `layout`: a .gdb holds every layer, a Shapefile directory one set per layer.
// `styling`: where a QGIS style can live — beside the layer file, inside the
// dataset, or nowhere at all, which is the case for a .gdb.
export interface VectorExportFormat {
  ogrDriver: 'OpenFileGDB' | 'GPKG' | 'ESRI Shapefile';
  extension: 'gdb' | 'gpkg' | 'shp';
  packaging: 'zip' | 'raw';
  layout: 'dataset' | 'layer-files';
  styling: 'sidecar' | 'table' | 'none';
  contentType: string;
  // The DBF header has no room for an alias and caps a field name at 10
  // characters, so Shapefile exports use the caller's shortName instead.
  shortFieldNames?: boolean;
  layerCreationOptions?: string[];
}

export const GDB_FORMAT: VectorExportFormat = {
  ogrDriver: 'OpenFileGDB',
  extension: 'gdb',
  packaging: 'zip',
  layout: 'dataset',
  styling: 'none',
  contentType: 'application/zip',
};

export const GPKG_FORMAT: VectorExportFormat = {
  ogrDriver: 'GPKG',
  extension: 'gpkg',
  packaging: 'raw',
  layout: 'dataset',
  styling: 'table',
  contentType: 'application/geopackage+sqlite3',
};

export const SHP_FORMAT: VectorExportFormat = {
  ogrDriver: 'ESRI Shapefile',
  extension: 'shp',
  packaging: 'zip',
  layout: 'layer-files',
  styling: 'sidecar',
  contentType: 'application/zip',
  shortFieldNames: true,
  // Without this the .dbf is written as ISO-8859-1 and every Lithuanian
  // character in a value arrives mangled.
  layerCreationOptions: ['ENCODING=UTF-8'],
};

// Shared fastest-validator schema for the /gdb and /gpkg actions. The two
// endpoints deliberately accept identical params so callers can switch
// export format by changing only the URL.
// Spelled as a string because fastest-validator compiles `pattern` itself.
const NO_CONTROL_CHARS = '^[^\\u0000-\\u001f\\u007f]+$';

export const vectorExportParams = {
  // Backward-compatible: pass `geojson` (single FeatureCollection) for a
  // one-layer export, OR pass `layers: [{ name, geojson }]` to produce a
  // multi-layer dataset. OpenFileGDB requires one geometry type per layer,
  // so callers needing to bundle mixed Points + Lines + Polygons must use
  // `layers` and split features by geometry.type themselves. (GPKG tolerates
  // mixed geometries in one layer, but splitting keeps callers
  // format-agnostic.)
  geojson: {
    type: 'object',
    optional: true,
    $$t: 'GeoJSON FeatureCollection to convert (single-layer mode).',
  },
  layers: {
    type: 'array',
    optional: true,
    max: MAX_LAYERS,
    items: {
      type: 'object',
      props: {
        name: {
          type: 'string',
          // Layer-name rules — what ogr2ogr accepts and what the call
          // site can splat into -nln safely. Allow ASCII letters + LT
          // diacritics (ąčęėįšųūž) + digits + underscore. Disallow
          // whitespace, shell metacharacters, and path separators —
          // ogr2ogr would launder spaces to underscores anyway, and the
          // shell:false spawn would not interpret quotes, but rejecting
          // them upfront keeps the contract predictable.
          // fastest-validator's `pattern` runs without the `u` flag, so
          // we can't use \p{L}; diacritics are spelled out instead.
          pattern: '^[A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž_][A-Za-z0-9ĄČĘĖĮŠŲŪŽąčęėįšųūž_]{0,63}$',
        },
        geojson: { type: 'object', optional: true },
        url: {
          type: 'url',
          optional: true,
          $$t: 'Fetch the layer GeoJSON from here instead of sending it inline. The host must be allowlisted server-side.',
        },
        // Optional per-field alias / type overrides. When provided, the
        // layer is fed through an OGR VRT wrapper so the exported dataset
        // carries the alternative names (what QGIS / ArcGIS surface in
        // the attribute table headers). A VRT exposes ONLY the fields it
        // declares, so a partial list drops every other property.
        fields: {
          type: 'array',
          optional: true,
          max: MAX_FIELDS,
          items: {
            type: 'object',
            props: {
              // libxml recovers from a control character, shipping a silently renamed column.
              name: { type: 'string', max: 64, pattern: NO_CONTROL_CHARS },
              shortName: { type: 'string', optional: true, max: 10, pattern: NO_CONTROL_CHARS },
              alias: { type: 'string', optional: true, max: 128, pattern: NO_CONTROL_CHARS },
              type: {
                type: 'enum',
                values: ['String', 'Integer', 'Integer64', 'Real', 'Date', 'DateTime'],
                optional: true,
                default: 'String',
              },
            },
          },
        },
      },
    },
    $$t: 'Per-layer GeoJSON FeatureCollections (multi-layer mode). Each layer becomes its own table inside the exported dataset; use this when objects of different geometry types must be bundled together. Each layer can optionally declare `fields[]` to set field types and display aliases via an OGR VRT wrapper.',
  },
  srid: {
    type: 'number',
    convert: true,
    optional: true,
    integer: true,
    min: 1024,
    max: 999999,
    default: 3346,
    $$t: 'Source / target SRID. Defaults to 3346 (LKS-94 — Lithuanian national grid)',
  },
  name: {
    type: 'string',
    optional: true,
    default: 'extract',
    // Defense in depth: even with shell:false + absolute paths, disallow
    // leading - or . to avoid edge-case argv parsing (--foo, ..) and bare
    // dotfiles. Also cap length.
    pattern: '^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$',
    $$t: 'Base name for the exported dataset and download file (alnum start; up to 64 chars of letters, digits, dot, dash, underscore)',
  },
};

// Just the slice of moleculer's LoggerInstance this module needs, so the util
// stays decoupled from the service that owns the logger.
export interface VectorExportLogger {
  error: (...args: unknown[]) => void;
}

export interface VectorExportInput {
  geojson?: VectorExportFeatureCollection;
  layers?: VectorExportLayer[];
  srid: number;
  name: string;
  format: VectorExportFormat;
  // Pass the calling service's logger so subprocess stderr is recorded
  // server-side instead of being returned to the caller.
  logger?: VectorExportLogger;
}

export interface VectorExportResult {
  stream: NodeJS.ReadableStream;
  size: number;
  filename: string;
  contentType: string;
}

export interface VectorExportMeta {
  $responseType: string;
  $statusCode: number;
  $responseHeaders: Record<string, string>;
}

export type VectorExportContext = Context<
  Pick<VectorExportInput, 'geojson' | 'layers' | 'srid' | 'name'>,
  VectorExportMeta
>;

export async function respondWithVectorExport(
  ctx: VectorExportContext,
  format: VectorExportFormat,
  logger?: VectorExportLogger,
): Promise<NodeJS.ReadableStream> {
  const { stream, size, filename, contentType } = await runVectorExport({
    ...ctx.params,
    format,
    logger,
  });

  ctx.meta.$responseType = contentType;
  ctx.meta.$statusCode = 200;
  ctx.meta.$responseHeaders = {
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': size.toString(),
  };

  return stream;
}

// Full export pipeline shared by the /shp, /gdb and /gpkg endpoints:
// validate → temp dir → optional VRT wrapper → ogr2ogr per layer →
// optional zip → readable stream that removes the temp dir on close.
// Normalize the two accepted input shapes into a single layers[] list and
// enforce every limit, so the rest of the pipeline doesn't branch and the
// guardrails can be unit-tested without touching the filesystem or GDAL.
// Pure: throws MoleculerClientError (4xx) on any invalid input.
const toLayerName = (name: string) => name.replace(/[^A-Za-z0-9ĄČĘĖĮŠŲŪŽąčęėįšųūž_]/g, '_');

export function resolveVectorExportLayers(
  input: Pick<VectorExportInput, 'geojson' | 'layers' | 'name'>,
): VectorExportLayer[] {
  const { geojson, layers, name } = input;

  // Single-layer callers get an auto-named layer matching the export's `name`
  // (the historical behaviour), sanitised: `name` is also a filename, so it allows dots a layer name cannot keep.
  const inputLayers: VectorExportLayer[] =
    Array.isArray(layers) && layers.length
      ? layers
      : geojson
      ? [{ name: toLayerName(name), geojson }]
      : [];

  if (!inputLayers.length) {
    throw new Errors.MoleculerClientError(
      'either `geojson` or `layers` is required',
      400,
      'NO_INPUT',
    );
  }

  // The `max` on the params schema only covers multi-layer mode; enforce the
  // cap here too so single-layer callers and internal callers of
  // runVectorExport() hit the same limit.
  if (inputLayers.length > MAX_LAYERS) {
    throw new Errors.MoleculerClientError(
      `too many layers: ${inputLayers.length} (max ${MAX_LAYERS})`,
      400,
      'TOO_MANY_LAYERS',
    );
  }

  let totalFeatures = 0;
  for (const layer of inputLayers) {
    if (layer.url) {
      if (layer.geojson) {
        throw new Errors.MoleculerClientError(
          `layer "${layer.name}": pass either \`geojson\` or \`url\`, not both`,
          400,
          'LAYER_INPUT_AMBIGUOUS',
        );
      }

      const host = new URL(layer.url).host.toLowerCase();
      if (!allowedSourceHosts().includes(host)) {
        // The host, never the url: a rejected url can carry a signature.
        throw new Errors.MoleculerClientError(
          `layer "${layer.name}": source host "${host}" is not allowed`,
          400,
          'URL_HOST_NOT_ALLOWED',
        );
      }

      continue;
    }

    if (!layer.geojson?.type || layer.geojson.type !== 'FeatureCollection') {
      throw new Errors.MoleculerClientError(
        `layer "${layer.name}": geojson must be a FeatureCollection`,
        400,
        'INVALID_GEOJSON',
      );
    }
    if (!Array.isArray(layer.geojson.features) || layer.geojson.features.length === 0) {
      throw new Errors.MoleculerClientError(
        `layer "${layer.name}": features must be a non-empty array`,
        400,
        'EMPTY_FEATURES',
      );
    }
    totalFeatures += layer.geojson.features.length;
  }

  // Every layer costs one GDAL process and every feature costs work inside it,
  // so cap the total rather than only the layer count.
  if (totalFeatures > MAX_TOTAL_FEATURES) {
    throw new Errors.MoleculerClientError(
      `too many features: ${totalFeatures} (max ${MAX_TOTAL_FEATURES})`,
      400,
      'TOO_MANY_FEATURES',
    );
  }

  // Reject duplicate layer names early — ogr2ogr would overwrite silently
  // and the user would lose data without an obvious clue. Compare
  // case-insensitively: GPKG layer names become SQLite table names, and
  // SQLite identifiers are case-insensitive, so ["roads", "Roads"] would pass
  // a case-sensitive check and then silently merge via -nln + -update -append.
  const seen = new Set<string>();
  for (const l of inputLayers) {
    const key = l.name.toLowerCase();
    if (seen.has(key)) {
      throw new Errors.MoleculerClientError(
        `duplicate layer name: "${l.name}"`,
        400,
        'DUPLICATE_LAYER',
      );
    }
    seen.add(key);
  }

  return inputLayers;
}

// Progress, not wall clock: a plain timer cut a slow client's download at the budget.
export function sweepAbandonedStream(
  stream: { bytesRead: number },
  onAbandoned: () => void,
): NodeJS.Timeout {
  const hardDeadline = Date.now() + DOWNLOAD_MAX_MS;
  let lastBytesRead = 0;
  const sweep = setInterval(() => {
    const stalled = stream.bytesRead === lastBytesRead;
    lastBytesRead = stream.bytesRead;
    if (!stalled && Date.now() < hardDeadline) return;

    clearInterval(sweep);
    onAbandoned();
  }, DOWNLOAD_IDLE_SWEEP_MS);
  sweep.unref();
  return sweep;
}

export async function runVectorExport(input: VectorExportInput): Promise<VectorExportResult> {
  const { srid, name, format, logger } = input;

  const inputLayers = resolveVectorExportLayers(input);

  const workDir = await fsp.mkdtemp(join(tmpdir(), `${format.extension}-`));
  // A Shapefile export is a directory of file sets named after the layers, so
  // its root carries no extension; the other two drivers take one dataset path.
  const isLayerFiles = format.layout === 'layer-files';
  const targetName = isLayerFiles ? name : `${name}.${format.extension}`;
  const targetPath = join(workDir, targetName);

  const budget: SourceBudget = { remaining: maxSourceBytes() };

  try {
    if (isLayerFiles) await fsp.mkdir(targetPath);

    // One dataset: the first layer creates it, the rest are appended as their
    // own tables. Layer files: every layer is its own independent write.
    // If a layer declares `fields`, wrap its GeoJSON in an OGR VRT XML
    // first so the result carries the declared types + alias names;
    // without VRT, ogr2ogr infers everything as String and the attribute
    // table shows no aliases.
    for (let i = 0; i < inputLayers.length; i++) {
      const layer = inputLayers[i];
      const layerGeojsonPath = join(workDir, `${layer.name}.geojson`);
      if (layer.url) {
        await fetchSource(layer.url, layerGeojsonPath, budget);
      } else {
        // Only what the layer is: GDAL names the source layer after a root `name` member, which the VRT's SrcLayer would then miss.
        await fsp.writeFile(
          layerGeojsonPath,
          JSON.stringify({ type: 'FeatureCollection', features: layer.geojson?.features || [] }),
        );
      }

      const ogrInputPath = layer.fields?.length
        ? await writeVrt(workDir, layer, !!format.shortFieldNames)
        : layerGeojsonPath;

      const ogrArgs = [
        // A `gdal_streamed_alg` json carries a gdal command line of its own, and reaches a local path through a fetched file or through the SrcDataSource of the vrt below, where `-if` has no say.
        ...(layer.url ? ['--config', 'OGR_SKIP', 'GDALG'] : []),
        '-f',
        format.ogrDriver,
        '-a_srs',
        `EPSG:${srid}`,
        '-nln',
        layer.name,
        ...(format.layerCreationOptions || []).flatMap((option) => ['-lco', option]),
        ...(isLayerFiles || i === 0 ? [] : ['-update', '-append']),
        isLayerFiles ? join(targetPath, `${layer.name}.${format.extension}`) : targetPath,
        ogrInputPath,
      ];
      await run('ogr2ogr', ogrArgs, { logger });
    }

    await attachStyles(targetPath, inputLayers, format, logger);

    const produced = isLayerFiles ? await fsp.readdir(targetPath) : [];
    // `zip` of an empty directory exits 0 with a 176-byte archive.
    if (isLayerFiles && !produced.length) {
      logger?.error('vector export produced no layer files', { targetPath });
      throw new Errors.MoleculerError('export produced no file', 500, 'EXPORT_EMPTY');
    }

    let outPath = targetPath;
    let filename = `${name}.${format.extension}`;
    if (format.packaging === 'zip') {
      outPath = join(workDir, `${name}.zip`);
      filename = `${name}.zip`;
      // Layer files go in AT the archive root, so `/vsizip/<zip>` is itself the
      // dataset: a wrapper folder makes QGIS refuse the archive it was handed.
      await run('zip', ['-rq', outPath, ...(isLayerFiles ? produced : [targetName])], {
        cwd: isLayerFiles ? targetPath : workDir,
        logger,
      });
    }

    const stat = await fsp.stat(outPath).catch(() => null);
    // A driver that writes nothing still exits 0, and a raw ENOENT would put the temp path in the response.
    if (!stat?.size) {
      logger?.error('vector export produced no file', { outPath });
      throw new Errors.MoleculerError('export produced no file', 500, 'EXPORT_EMPTY');
    }

    const stream = createReadStream(outPath);
    // Stream ends -> safe to remove the workDir. Errors on the stream
    // bubble up via the response; cleanup still happens.
    const cleanup = () => fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});

    // Safety net. moleculer-web pipes this stream into the response without
    // destroying it when the client disconnects, so an aborted download
    // unpipes (pausing the source) without ever emitting 'close' or 'error' —
    // and the temp dir plus its fd would leak for the life of the process.
    // Repeat that and /tmp fills up. Destroy and sweep once the export's own
    // budget is spent.
    const sweep = sweepAbandonedStream(stream, () => {
      logger?.error('vector export stream abandoned, sweeping temp dir', { workDir });
      stream.destroy();
      cleanup();
    });

    const finish = () => {
      clearInterval(sweep);
      cleanup();
    };
    stream.on('close', finish);
    stream.on('error', finish);

    return { stream, size: stat.size, filename, contentType: format.contentType };
  } catch (e) {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

type StyleGeometry = 'point' | 'line' | 'polygon';

// QgsWkbTypes::GeometryType — QGIS refuses a style whose type is not the layer's.
const STYLE_GEOMETRY_CODE: Record<StyleGeometry, number> = { point: 0, line: 1, polygon: 2 };

const STYLE_COLOR = '227,26,28';

const styleProps = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([k, v]) => `<prop k="${k}" v="${v}"/>`)
    .join('');

// A fixed 3mm circle, the way the PDF map draws one: a 3m² hull covers less
// than a pixel, so without it a real extract reads as an empty map.
const markerSymbol = (name: string) =>
  `<symbol type="marker" name="${name}" alpha="1" clip_to_extent="1" force_rhr="0">` +
  `<layer class="SimpleMarker" enabled="1" locked="0" pass="0">` +
  styleProps({
    name: 'circle',
    color: `${STYLE_COLOR},255`,
    outline_color: '255,255,255,255',
    outline_width: '0.4',
    outline_width_unit: 'MM',
    size: '3',
    size_unit: 'MM',
    scale_method: 'diameter',
    angle: '0',
    offset: '0,0',
    offset_unit: 'MM',
    horizontal_anchor_point: '1',
    vertical_anchor_point: '1',
    joinstyle: 'bevel',
  }) +
  '</layer></symbol>';

const STYLE_SYMBOLS: Record<StyleGeometry, () => string> = {
  point: () => markerSymbol('0'),
  line: () =>
    '<symbol type="line" name="0" alpha="1" clip_to_extent="1" force_rhr="0">' +
    '<layer class="SimpleLine" enabled="1" locked="0" pass="0">' +
    styleProps({
      line_color: `${STYLE_COLOR},255`,
      line_width: '0.6',
      line_width_unit: 'MM',
      line_style: 'solid',
      capstyle: 'square',
      joinstyle: 'bevel',
      offset: '0',
      offset_unit: 'MM',
    }) +
    '</layer></symbol>',
  polygon: () =>
    '<symbol type="fill" name="0" alpha="1" clip_to_extent="1" force_rhr="0">' +
    '<layer class="SimpleFill" enabled="1" locked="0" pass="0">' +
    styleProps({
      style: 'solid',
      color: `${STYLE_COLOR},90`,
      outline_style: 'solid',
      outline_color: `${STYLE_COLOR},255`,
      outline_width: '0.4',
      outline_width_unit: 'MM',
      joinstyle: 'bevel',
      offset: '0,0',
      offset_unit: 'MM',
    }) +
    '</layer>' +
    '<layer class="CentroidFill" enabled="1" locked="0" pass="0">' +
    styleProps({
      point_on_all_parts: '1',
      point_on_surface: '0',
      clip_on_current_part_only: '0',
      clip_points: '0',
    }) +
    markerSymbol('@0@1') +
    '</layer></symbol>',
};

function qmlDocument(geometry: StyleGeometry): string {
  return [
    "<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>",
    '<qgis version="3.28.0" styleCategories="Symbology">',
    '  <renderer-v2 type="singleSymbol" forceraster="0" symbollevels="0" enableorderby="0">',
    `    <symbols>${STYLE_SYMBOLS[geometry]()}</symbols>`,
    '  </renderer-v2>',
    `  <layerGeometryType>${STYLE_GEOMETRY_CODE[geometry]}</layerGeometryType>`,
    '</qgis>',
    '',
  ].join('\n');
}

// QGIS keeps a geopackage's styles in a table of its own, and reads the default
// one straight from the provider — the only style that survives without unzipping.
const QGIS_STYLE_TABLE =
  'CREATE TABLE IF NOT EXISTS layer_styles (id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
  'f_table_catalog TEXT, f_table_schema TEXT, f_table_name TEXT, f_geometry_column TEXT, ' +
  'styleName TEXT, styleQML TEXT, styleSLD TEXT, useAsDefault BOOLEAN, description TEXT, ' +
  "owner TEXT, ui TEXT, update_time DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))";

const quoteSql = (value: string) => `'${value.replace(/'/g, "''")}'`;

const WKT_STYLE_GEOMETRY: Record<string, StyleGeometry> = {
  POINT: 'point',
  MULTIPOINT: 'point',
  LINESTRING: 'line',
  MULTILINESTRING: 'line',
  POLYGON: 'polygon',
  MULTIPOLYGON: 'polygon',
};

// The layer header reads "Unknown (any)" as soon as a layer mixes Polygon with
// MultiPolygon, so the shape comes from a feature instead.
async function layerGeometry(
  dataset: string,
  layerName: string,
  logger?: VectorExportLogger,
): Promise<StyleGeometry | undefined> {
  const info = await run(
    'ogrinfo',
    [
      '-ro',
      '-q',
      dataset,
      '-dialect',
      'OGRSQL',
      '-sql',
      `SELECT OGR_GEOMETRY FROM "${layerName.replace(/"/g, '""')}" LIMIT 1`,
    ],
    { logger },
  );

  const wkt = info.match(/OGR_GEOMETRY \(String\) = (\w+)/)?.[1] || '';
  return WKT_STYLE_GEOMETRY[wkt.toUpperCase().replace(/25D$/, '')];
}

// QGIS loads `<basename>.qml` beside a shapefile by itself; a geopackage carries
// the same document in `layer_styles`. A .gdb has nowhere to put one.
async function attachStyles(
  target: string,
  layers: VectorExportLayer[],
  format: VectorExportFormat,
  logger?: VectorExportLogger,
): Promise<void> {
  if (format.styling === 'none') return;

  try {
    if (format.styling === 'table') await run('ogrinfo', [target, '-sql', QGIS_STYLE_TABLE], { logger });

    for (const layer of layers) {
      const sidecar = format.styling === 'sidecar';
      const dataset = sidecar ? join(target, `${layer.name}.${format.extension}`) : target;
      const geometry = await layerGeometry(dataset, layer.name, logger);
      if (!geometry) continue;

      const qml = qmlDocument(geometry);
      if (sidecar) {
        await fsp.writeFile(join(target, `${layer.name}.qml`), qml);
        continue;
      }

      await run(
        'ogrinfo',
        [
          target,
          '-sql',
          'INSERT INTO layer_styles (f_table_catalog, f_table_schema, f_table_name, ' +
            'f_geometry_column, styleName, styleQML, useAsDefault) VALUES ' +
            `('', '', ${quoteSql(layer.name)}, 'geom', ${quoteSql(layer.name)}, ${quoteSql(qml)}, 1)`,
        ],
        { logger },
      );
    }
  } catch (e: unknown) {
    // Symbology is a nicety and the layers themselves are the deliverable, so losing it must not sink the export.
    logger?.error('vector export could not attach the layer styles', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// Wrap a layer's GeoJSON in an OGR VRT XML document that declares each
// listed field's type and alternativeName. ogr2ogr reads the VRT (which in
// turn references the on-disk GeoJSON) and writes tables that carry the
// types + aliases. Returns the path to the .vrt file — pass that to
// ogr2ogr instead of the raw .geojson.
//
// Without VRT, ogr2ogr's GeoJSON reader stores every property as String
// and has nowhere to put an alias, so the resulting attribute table reads
// like the snake_case field names with no human label and no numeric type
// info.
// One byte budget for the whole export, so N layers cannot each spend the cap.
interface SourceBudget {
  remaining: number;
}

function sourceIdleMs(): number {
  return Number(process.env.VECTOR_EXPORT_SOURCE_IDLE_MS) || DEFAULT_SOURCE_IDLE_MS;
}

function openSource(url: string): Promise<IncomingMessage> {
  const get = url.startsWith('https:') ? httpsGet : httpGet;

  return new Promise<IncomingMessage>((resolve, reject) => {
    const fail = (detail: string) =>
      // Status or syscall only: the body of a refused fetch carries the store's own detail.
      reject(
        new Errors.MoleculerError(`source fetch failed: ${detail}`, 502, 'SOURCE_FETCH_FAILED'),
      );

    const request = get(url, (response) => {
      const status = response.statusCode || 0;
      if (status < 200 || status > 299) {
        response.resume();
        return fail(`HTTP ${status}`);
      }
      resolve(response);
    }).on('error', (e: NodeJS.ErrnoException) => fail(e.code || e.message));

    // The socket outlives the headers, so this also covers a body that stalls mid-download.
    request.setTimeout(sourceIdleMs(), () => request.destroy(new Error('ETIMEDOUT')));
  });
}

async function fetchSource(url: string, path: string, budget: SourceBudget): Promise<void> {
  const response = await openSource(url);

  const counted = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      budget.remaining -= chunk.length;
      if (budget.remaining < 0) {
        return done(
          new Errors.MoleculerError(
            `source exceeds the ${maxSourceBytes()} byte budget`,
            413,
            'SOURCE_TOO_LARGE',
          ),
        );
      }
      done(null, chunk);
    },
  });

  await pipeline(response, counted, createWriteStream(path));

  // Answers the wrong object with a clear 422 instead of an opaque ogr2ogr error, and keeps an XML VRT from being opened as a datasource of its own; a json head alone is not the guard, the driver skip is.
  const head = Buffer.alloc(SOURCE_HEAD_BYTES);
  const handle = await fsp.open(path, 'r');
  const { bytesRead } = await handle.read(head, 0, head.length, 0).finally(() => handle.close());
  const headText = head.subarray(0, bytesRead).toString('utf8');
  if (!/^\s*\{/.test(headText) || !/"type"\s*:\s*"FeatureCollection"/.test(headText)) {
    throw new Errors.MoleculerError(
      'source must open as a GeoJSON FeatureCollection',
      422,
      'SOURCE_NOT_GEOJSON',
    );
  }
}

async function writeVrt(
  workDir: string,
  layer: VectorExportLayer,
  shortFieldNames: boolean,
): Promise<string> {
  // GeoJSON layer name == basename of the .geojson file (without the
  // extension), so OGR can find it via the VRT's <SrcLayer>.
  const geojsonLayerName = layer.name;
  const geojsonPath = `${geojsonLayerName}.geojson`; // relative to workDir
  const fieldXml = (layer.fields ?? [])
    .map((f) => {
      const exportedName = (shortFieldNames && f.shortName) || f.name;
      // Only when renaming: an explicit `src` that resolves to nothing empties the whole layer, where an implicit one yields a null column.
      const attrs = [`name="${escapeXml(exportedName)}"`];
      if (exportedName !== f.name) attrs.push(`src="${escapeXml(f.name)}"`);
      if (f.type) attrs.push(`type="${escapeXml(f.type)}"`);
      if (f.alias) attrs.push(`alternativeName="${escapeXml(f.alias)}"`);
      return `    <Field ${attrs.join(' ')}/>`;
    })
    .join('\n');
  const vrtXml = [
    '<OGRVRTDataSource>',
    `  <OGRVRTLayer name="${escapeXml(layer.name)}">`,
    `    <SrcDataSource relativeToVRT="1">${escapeXml(geojsonPath)}</SrcDataSource>`,
    `    <SrcLayer>${escapeXml(geojsonLayerName)}</SrcLayer>`,
    fieldXml,
    '  </OGRVRTLayer>',
    '</OGRVRTDataSource>',
    '',
  ].join('\n');
  const vrtPath = join(workDir, `${layer.name}.vrt`);
  await fsp.writeFile(vrtPath, vrtXml);
  return vrtPath;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

interface RunOptions {
  cwd?: string;
  logger?: VectorExportLogger;
}

// GDAL reports a fatal data error (a VRT source field it cannot find, a field
// it cannot create) on stderr and still exits 0, leaving an empty dataset that
// would otherwise be packaged, uploaded and announced as a finished export.
const SUBPROCESS_ERROR_LINE = /^ERROR \d+/m;

function run(command: string, args: string[], { cwd, logger }: RunOptions) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    // Bounded buffers: keep the head of each stream (where the actionable error,
    // and the answer to a query, is) rather than growing with feature count. An
    // unread stdout pipe would also block a chatty child once it fills.
    let stderr = '';
    let stdout = '';
    const collect = (into: 'out' | 'err') => (chunk: string) => {
      if (into === 'out' && stdout.length < MAX_STDERR_CHARS) {
        stdout += chunk.slice(0, MAX_STDERR_CHARS - stdout.length);
      } else if (into === 'err' && stderr.length < MAX_STDERR_CHARS) {
        stderr += chunk.slice(0, MAX_STDERR_CHARS - stderr.length);
      }
    };
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', collect('err'));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', collect('out'));

    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0 && !SUBPROCESS_ERROR_LINE.test(stderr)) return resolve(stdout);

      // stderr carries absolute temp paths, GDAL/PROJ versions and sometimes
      // fragments of the submitted data. moleculer-web's reformatError copies
      // both `message` and `data` straight into the response body, so neither
      // may carry it — it goes to the server log only.
      logger?.error(`${command} failed`, { command, args, code, signal, stderr });

      reject(
        new Errors.MoleculerError(
          `${command} failed to produce the export`,
          500,
          `${command.toUpperCase()}_FAILED`,
        ),
      );
    });
  });
}
