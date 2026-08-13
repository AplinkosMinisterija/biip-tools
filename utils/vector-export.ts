'use strict';

import { spawn } from 'child_process';
import { createReadStream, promises as fsp } from 'fs';
import { Errors } from 'moleculer';
import { tmpdir } from 'os';
import { join } from 'path';

export interface VectorExportField {
  name: string;
  alias?: string;
  type?: string;
}

export interface VectorExportLayer {
  name: string;
  geojson: any;
  fields?: VectorExportField[];
}

// How a target format maps onto the shared ogr2ogr pipeline. `packaging`
// exists because OpenFileGDB produces a directory (which must be zipped to
// travel over HTTP) while GPKG is a single SQLite file served as-is.
export interface VectorExportFormat {
  ogrDriver: 'OpenFileGDB' | 'GPKG';
  extension: 'gdb' | 'gpkg';
  packaging: 'zip' | 'raw';
  contentType: string;
}

export const GDB_FORMAT: VectorExportFormat = {
  ogrDriver: 'OpenFileGDB',
  extension: 'gdb',
  packaging: 'zip',
  contentType: 'application/zip',
};

export const GPKG_FORMAT: VectorExportFormat = {
  ogrDriver: 'GPKG',
  extension: 'gpkg',
  packaging: 'raw',
  contentType: 'application/geopackage+sqlite3',
};

// Shared fastest-validator schema for the /gdb and /gpkg actions. The two
// endpoints deliberately accept identical params so callers can switch
// export format by changing only the URL.
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
        // the attribute table headers). Field names not listed here keep
        // their inferred String type and no alias.
        fields: {
          type: 'array',
          optional: true,
          items: {
            type: 'object',
            props: {
              name: 'string',
              alias: { type: 'string', optional: true },
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

export interface VectorExportInput {
  geojson?: any;
  layers?: VectorExportLayer[];
  srid: number;
  name: string;
  format: VectorExportFormat;
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
export async function runVectorExport(input: VectorExportInput): Promise<VectorExportResult> {
  const { geojson, layers, srid, name, format } = input;

  // Normalize both shapes into a single layers[] list so the rest of the
  // pipeline doesn't branch. Single-layer callers get an auto-named layer
  // matching the export's `name` (the historical behaviour).
  const inputLayers: VectorExportLayer[] = (() => {
    if (Array.isArray(layers) && layers.length) return layers;
    if (geojson) return [{ name, geojson }];
    throw new Errors.MoleculerClientError(
      'either `geojson` or `layers` is required',
      400,
      'NO_INPUT',
    );
  })();

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
  }

  // Reject duplicate layer names early — ogr2ogr would overwrite silently
  // and the user would lose data without an obvious clue.
  const seen = new Set<string>();
  for (const l of inputLayers) {
    if (seen.has(l.name)) {
      throw new Errors.MoleculerClientError(
        `duplicate layer name: "${l.name}"`,
        400,
        'DUPLICATE_LAYER',
      );
    }
    seen.add(l.name);
  }

  const workDir = await fsp.mkdtemp(join(tmpdir(), `${format.extension}-`));
  const targetPath = join(workDir, `${name}.${format.extension}`);

  try {
    // First layer: create the dataset. Subsequent layers: -update -append
    // so each one becomes its own table inside the same dataset.
    // If a layer declares `fields`, wrap its GeoJSON in an OGR VRT XML
    // first so the result carries the declared types + alias names;
    // without VRT, ogr2ogr infers everything as String and the attribute
    // table shows no aliases.
    for (let i = 0; i < inputLayers.length; i++) {
      const layer = inputLayers[i];
      const layerGeojsonPath = join(workDir, `${layer.name}.geojson`);
      await fsp.writeFile(layerGeojsonPath, JSON.stringify(layer.geojson));

      const ogrInputPath = layer.fields?.length ? await writeVrt(workDir, layer) : layerGeojsonPath;

      const ogrArgs = [
        '-f',
        format.ogrDriver,
        '-a_srs',
        `EPSG:${srid}`,
        '-nln',
        layer.name,
        ...(i === 0 ? [] : ['-update', '-append']),
        targetPath,
        ogrInputPath,
      ];
      await run('ogr2ogr', ogrArgs);
    }

    let outPath = targetPath;
    let filename = `${name}.${format.extension}`;
    if (format.packaging === 'zip') {
      // Pack the dataset at workDir root so the archive entry is
      // "<name>.<ext>/..." (the conventional layout ArcGIS / QGIS expect).
      outPath = join(workDir, `${name}.zip`);
      filename = `${name}.zip`;
      await run('zip', ['-rq', outPath, `${name}.${format.extension}`], workDir);
    }

    const stat = await fsp.stat(outPath);

    const stream = createReadStream(outPath);
    // Stream ends -> safe to remove the workDir. Errors on the stream
    // bubble up via the response; cleanup still happens.
    const cleanup = () => fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    stream.on('close', cleanup);
    stream.on('error', cleanup);

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
async function writeVrt(workDir: string, layer: VectorExportLayer): Promise<string> {
  // GeoJSON layer name == basename of the .geojson file (without the
  // extension), so OGR can find it via the VRT's <SrcLayer>.
  const geojsonLayerName = layer.name;
  const geojsonPath = `${geojsonLayerName}.geojson`; // relative to workDir
  const fieldXml = (layer.fields ?? [])
    .map((f) => {
      const attrs = [`name="${escapeXml(f.name)}"`];
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

function run(command: string, args: string[], cwd?: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    const stderrChunks: string[] = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => stderrChunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve();
      const stderr = stderrChunks.join('');
      reject(
        new Errors.MoleculerError(
          `${command} exited with code ${code}: ${stderr || '<no stderr>'}`,
          500,
          `${command.toUpperCase()}_FAILED`,
        ),
      );
    });
  });
}
