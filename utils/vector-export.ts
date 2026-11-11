'use strict';

import { spawn } from 'child_process';
import { createReadStream, promises as fsp } from 'fs';
import { Errors } from 'moleculer';
import { tmpdir } from 'os';
import { join } from 'path';

// The endpoints are unauthenticated and a ~137-byte layer costs one GDAL
// process, so a 25MB body could ask for ~180k sequential ogr2ogr spawns.
export const MAX_LAYERS = 32;
// One VRT column per field, and the DBF/GDB ceiling is 255 anyway.
export const MAX_FIELDS = 255;
export const MAX_TOTAL_FEATURES = 500_000;

// Under undici's 300s header deadline: a caller on node's global fetch cannot
// wait longer, so a bigger budget only buys an opaque "fetch failed".
export const VECTOR_EXPORT_TIMEOUT_MS = 4 * 60 * 1000;

// Per-process ceiling, applied on top of whatever is left of the deadline.
const SUBPROCESS_TIMEOUT_MS = 2 * 60 * 1000;

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
  geojson: VectorExportFeatureCollection;
  fields?: VectorExportField[];
}

// `packaging`: GDB and Shapefile produce a directory to zip, GPKG one file.
// `layout`: a .gdb holds every layer, a Shapefile directory one set per layer.
export interface VectorExportFormat {
  ogrDriver: 'OpenFileGDB' | 'GPKG' | 'ESRI Shapefile';
  extension: 'gdb' | 'gpkg' | 'shp';
  packaging: 'zip' | 'raw';
  layout: 'dataset' | 'layer-files';
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
  contentType: 'application/zip',
};

export const GPKG_FORMAT: VectorExportFormat = {
  ogrDriver: 'GPKG',
  extension: 'gpkg',
  packaging: 'raw',
  layout: 'dataset',
  contentType: 'application/geopackage+sqlite3',
};

export const SHP_FORMAT: VectorExportFormat = {
  ogrDriver: 'ESRI Shapefile',
  extension: 'shp',
  packaging: 'zip',
  layout: 'layer-files',
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
        geojson: 'object',
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

// Full export pipeline shared by the /gdb and /gpkg endpoints:
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

export async function runVectorExport(input: VectorExportInput): Promise<VectorExportResult> {
  const { srid, name, format, logger } = input;

  const inputLayers = resolveVectorExportLayers(input);

  const workDir = await fsp.mkdtemp(join(tmpdir(), `${format.extension}-`));
  // A Shapefile export is a directory of file sets named after the layers, so
  // its root carries no extension; the other two drivers take one dataset path.
  const isLayerFiles = format.layout === 'layer-files';
  const targetName = isLayerFiles ? name : `${name}.${format.extension}`;
  const targetPath = join(workDir, targetName);

  // One budget for the whole export, so N layers cannot each spend the full
  // per-process timeout and turn a bounded fan-out into an unbounded runtime.
  const deadline = Date.now() + VECTOR_EXPORT_TIMEOUT_MS;

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
      // Only what the layer is: GDAL names the source layer after a root `name` member, which the VRT's SrcLayer would then miss.
      await fsp.writeFile(
        layerGeojsonPath,
        JSON.stringify({ type: 'FeatureCollection', features: layer.geojson.features || [] }),
      );

      const ogrInputPath = layer.fields?.length
        ? await writeVrt(workDir, layer, !!format.shortFieldNames)
        : layerGeojsonPath;

      const ogrArgs = [
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
      await run('ogr2ogr', ogrArgs, { deadline, logger });
    }

    // `zip` of an empty directory exits 0 with a 176-byte archive.
    if (isLayerFiles && !(await fsp.readdir(targetPath)).length) {
      logger?.error('vector export produced no layer files', { targetPath });
      throw new Errors.MoleculerError('export produced no file', 500, 'EXPORT_EMPTY');
    }

    let outPath = targetPath;
    let filename = `${name}.${format.extension}`;
    if (format.packaging === 'zip') {
      // Pack the dataset at workDir root so the archive entry is
      // "<name>.<ext>/..." (the conventional layout ArcGIS / QGIS expect).
      outPath = join(workDir, `${name}.zip`);
      filename = `${name}.zip`;
      await run('zip', ['-rq', outPath, targetName], {
        cwd: workDir,
        deadline,
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
    // Progress, not wall clock: a plain timer cut a slow client's download at the budget.
    let lastBytesRead = 0;
    const sweep = setInterval(() => {
      if (stream.bytesRead !== lastBytesRead) {
        lastBytesRead = stream.bytesRead;
        return;
      }

      logger?.error('vector export stream abandoned, sweeping temp dir', { workDir });
      clearInterval(sweep);
      stream.destroy();
      cleanup();
    }, VECTOR_EXPORT_TIMEOUT_MS);
    sweep.unref();

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
      // `src` names the GeoJSON property, so a renamed field still reads it.
      const attrs = [`name="${escapeXml(exportedName)}"`, `src="${escapeXml(f.name)}"`];
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
  // Absolute epoch ms by which the whole export must be done. The child gets
  // whatever is left of it, capped at SUBPROCESS_TIMEOUT_MS.
  deadline: number;
  logger?: VectorExportLogger;
}

// GDAL reports a fatal data error (a VRT source field it cannot find, a field
// it cannot create) on stderr and still exits 0, leaving an empty dataset that
// would otherwise be packaged, uploaded and announced as a finished export.
const SUBPROCESS_ERROR_LINE = /^ERROR \d+/m;

function run(command: string, args: string[], { cwd, deadline, logger }: RunOptions) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return Promise.reject(
      new Errors.MoleculerError('export exceeded its time budget', 504, 'EXPORT_TIMEOUT'),
    );
  }

  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      // Without these the child outlives any broker timeout — the request is
      // abandoned but GDAL keeps burning CPU until it finishes on its own.
      timeout: Math.min(remaining, SUBPROCESS_TIMEOUT_MS),
      killSignal: 'SIGKILL',
    });

    // Bounded buffer: keep the head of stderr (where the actionable error is)
    // and drop the rest rather than growing with feature count.
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_STDERR_CHARS) {
        stderr += chunk.slice(0, MAX_STDERR_CHARS - stderr.length);
      }
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0 && !SUBPROCESS_ERROR_LINE.test(stderr)) return resolve();

      // stderr carries absolute temp paths, GDAL/PROJ versions and sometimes
      // fragments of the submitted data. moleculer-web's reformatError copies
      // both `message` and `data` straight into the response body, so neither
      // may carry it — it goes to the server log only.
      logger?.error(`${command} failed`, { command, args, code, signal, stderr });

      // spawn's `timeout` kills with killSignal, so a null exit code plus our
      // signal means we ran out of budget rather than hitting a data error.
      if (signal === 'SIGKILL') {
        return reject(
          new Errors.MoleculerError(`${command} exceeded its time budget`, 504, 'EXPORT_TIMEOUT'),
        );
      }

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
