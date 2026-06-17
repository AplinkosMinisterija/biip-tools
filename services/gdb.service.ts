'use strict';

import { spawn } from 'child_process';
import { promises as fsp, createReadStream } from 'fs';
import moleculer, { Context, Errors } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
import { tmpdir } from 'os';
import { join } from 'path';

@Service({
  name: 'gdb',
})
export default class GdbService extends moleculer.Service {
  @Action({
    openapi: {
      summary:
        'Converts a GeoJSON FeatureCollection to an ESRI File Geodatabase (OpenFileGDB) packed as a ZIP archive.',
      responses: {
        '200': {
          description: 'ZIP archive containing the .gdb directory.',
          content: {
            'application/zip': {
              schema: { type: 'string', format: 'binary' },
            },
          },
        },
      },
    },
    params: {
      // Backward-compatible: pass `geojson` (single FeatureCollection) for a
      // one-layer GDB, OR pass `layers: [{ name, geojson }]` to produce a
      // multi-layer GDB. OpenFileGDB requires one geometry type per layer, so
      // callers needing to bundle mixed Points + Lines + Polygons must use
      // `layers` and split features by geometry.type themselves.
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
              // Layer-name rules — what ogr2ogr / OpenFileGDB accept and
              // what the call site can splat into -nln safely. Allow
              // ASCII letters + LT diacritics (ąčęėįšųūž) + digits +
              // underscore. Disallow whitespace, shell metacharacters,
              // and path separators — ogr2ogr would launder spaces to
              // underscores anyway, and the shell:false spawn would
              // not interpret quotes, but rejecting them upfront keeps
              // the contract predictable. fastest-validator's `pattern`
              // runs without the `u` flag, so we can't use \p{L};
              // diacritics are spelled out instead.
              pattern:
                '^[A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž_][A-Za-z0-9ĄČĘĖĮŠŲŪŽąčęėįšųūž_]{0,63}$',
            },
            geojson: 'object',
          },
        },
        $$t:
          'Per-layer GeoJSON FeatureCollections (multi-layer mode). Each layer becomes its own table inside the .gdb; use this when objects of different geometry types must be bundled together.',
      },
      srid: {
        type: 'number',
        convert: true,
        optional: true,
        default: 3346,
        $$t:
          'Source / target SRID. Defaults to 3346 (LKS-94 — Lithuanian national grid)',
      },
      name: {
        type: 'string',
        optional: true,
        default: 'extract',
        // Defense in depth: even with shell:false + absolute paths, disallow
        // leading - or . to avoid edge-case argv parsing (--foo, ..) and bare
        // dotfiles. Also cap length.
        pattern: '^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$',
        $$t:
          'Base name for the .gdb directory inside the ZIP (alnum start; up to 64 chars of letters, digits, dot, dash, underscore)',
      },
    },
    rest: ['POST /'],
    timeout: 0,
  })
  async create(
    ctx: Context<
      {
        geojson?: any;
        layers?: Array<{ name: string; geojson: any }>;
        srid: number;
        name: string;
      },
      {
        $responseType: string;
        $statusCode: number;
        $responseHeaders: any;
      }
    >,
  ) {
    const { geojson, layers, srid, name } = ctx.params;

    // Normalize both shapes into a single layers[] list so the rest of the
    // pipeline doesn't branch. Single-layer callers get an auto-named layer
    // matching the archive's `name` (the historical behaviour).
    const inputLayers: Array<{ name: string; geojson: any }> = (() => {
      if (Array.isArray(layers) && layers.length) return layers;
      if (geojson) return [{ name, geojson }];
      throw new Errors.MoleculerClientError(
        'either `geojson` or `layers` is required',
        400,
        'NO_INPUT',
      );
    })();

    for (const layer of inputLayers) {
      if (
        !layer.geojson?.type ||
        layer.geojson.type !== 'FeatureCollection'
      ) {
        throw new Errors.MoleculerClientError(
          `layer "${layer.name}": geojson must be a FeatureCollection`,
          400,
          'INVALID_GEOJSON',
        );
      }
      if (
        !Array.isArray(layer.geojson.features) ||
        layer.geojson.features.length === 0
      ) {
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

    const workDir = await fsp.mkdtemp(join(tmpdir(), `gdb-`));
    const gdbDir = join(workDir, `${name}.gdb`);
    const zipPath = join(workDir, `${name}.zip`);

    try {
      // First layer: create the .gdb. Subsequent layers: -update -append so
      // each one becomes its own table inside the same .gdb directory.
      for (let i = 0; i < inputLayers.length; i++) {
        const layer = inputLayers[i];
        const layerGeojsonPath = join(workDir, `${layer.name}.geojson`);
        await fsp.writeFile(
          layerGeojsonPath,
          JSON.stringify(layer.geojson),
        );

        const ogrArgs = [
          '-f',
          'OpenFileGDB',
          '-a_srs',
          `EPSG:${srid}`,
          '-nln',
          layer.name,
          ...(i === 0 ? [] : ['-update', '-append']),
          gdbDir,
          layerGeojsonPath,
        ];
        await this.runOgr2Ogr(ogrArgs);
      }

      // Pack the .gdb directory at workDir root so the archive entry is
      // "<name>.gdb/..." (the conventional layout ArcGIS / QGIS expect).
      await this.runZip(['-rq', zipPath, `${name}.gdb`], workDir);

      const stat = await fsp.stat(zipPath);

      ctx.meta.$responseType = 'application/zip';
      ctx.meta.$statusCode = 200;
      ctx.meta.$responseHeaders = {
        'Content-Disposition': `attachment; filename="${name}.zip"`,
        'Content-Length': stat.size.toString(),
      };

      const stream = createReadStream(zipPath);
      // Stream ends -> safe to remove the workDir. Errors on the stream
      // bubble up via the response; cleanup still happens.
      const cleanup = () =>
        fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
      stream.on('close', cleanup);
      stream.on('error', cleanup);

      return stream;
    } catch (e) {
      await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
  }

  @Method
  runOgr2Ogr(args: string[]) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn('ogr2ogr', args, {
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
            `ogr2ogr exited with code ${code}: ${stderr || '<no stderr>'}`,
            500,
            'OGR2OGR_FAILED',
          ),
        );
      });
    });
  }

  @Method
  runZip(args: string[], cwd: string) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn('zip', args, {
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
            `zip exited with code ${code}: ${stderr || '<no stderr>'}`,
            500,
            'ZIP_FAILED',
          ),
        );
      });
    });
  }
}
