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
      geojson: {
        type: 'object',
        $$t: 'GeoJSON FeatureCollection to convert',
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
        pattern: '^[A-Za-z0-9._-]+$',
        $$t:
          'Base name for the .gdb directory inside the ZIP (must be a safe filename — letters, digits, dot, dash, underscore)',
      },
    },
    rest: ['POST /'],
    timeout: 0,
  })
  async create(
    ctx: Context<
      { geojson: any; srid: number; name: string },
      {
        $responseType: string;
        $statusCode: number;
        $responseHeaders: any;
      }
    >,
  ) {
    const { geojson, srid, name } = ctx.params;

    if (!geojson?.type || geojson.type !== 'FeatureCollection') {
      throw new Errors.MoleculerClientError(
        'geojson must be a FeatureCollection',
        400,
        'INVALID_GEOJSON',
      );
    }
    if (!Array.isArray(geojson.features) || geojson.features.length === 0) {
      throw new Errors.MoleculerClientError(
        'geojson.features must be a non-empty array',
        400,
        'EMPTY_FEATURES',
      );
    }

    const workDir = await fsp.mkdtemp(join(tmpdir(), `gdb-`));
    const geojsonPath = join(workDir, `${name}.geojson`);
    const gdbDir = join(workDir, `${name}.gdb`);
    const zipPath = join(workDir, `${name}.zip`);

    try {
      await fsp.writeFile(geojsonPath, JSON.stringify(geojson));

      // ogr2ogr: GeoJSON -> OpenFileGDB. -a_srs assigns the input's spatial
      // reference (GeoJSON spec defines CRS84 but biip uses 3346 throughout).
      // Binary path is literal; inputs are paths inside our private workDir.
      await this.runOgr2Ogr([
        '-f',
        'OpenFileGDB',
        '-a_srs',
        `EPSG:${srid}`,
        gdbDir,
        geojsonPath,
      ]);

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
      const stderrChunks: Buffer[] = [];
      child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) return resolve();
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
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
      const stderrChunks: Buffer[] = [];
      child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) return resolve();
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
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
