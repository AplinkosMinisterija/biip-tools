'use strict';

import { spawn } from 'child_process';
import { promises as fsp, createReadStream } from 'fs';
import moleculer, { Context, Errors } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
import { tmpdir } from 'os';
import { join } from 'path';

@Service({
  name: 'reproject',
})
export default class ReprojectService extends moleculer.Service {
  @Action({
    openapi: {
      summary:
        'Reprojects a GeoJSON FeatureCollection from one CRS to another via ogr2ogr.',
      responses: {
        '200': {
          description:
            'Reprojected GeoJSON FeatureCollection (application/geo+json).',
          content: {
            'application/geo+json': {
              schema: { type: 'string', format: 'binary' },
            },
          },
        },
      },
    },
    params: {
      geojson: {
        type: 'object',
        $$t: 'GeoJSON FeatureCollection to reproject',
      },
      sourceSrid: {
        type: 'number',
        convert: true,
        optional: true,
        default: 3346,
        $$t:
          'Input CRS as an EPSG SRID. Defaults to 3346 (LKS-94 — Lithuanian national grid)',
      },
      targetSrid: {
        type: 'number',
        convert: true,
        optional: true,
        default: 4326,
        $$t:
          'Output CRS as an EPSG SRID. Defaults to 4326 (WGS84 — the GeoJSON spec default, which QGIS / Leaflet / web tools assume)',
      },
    },
    rest: ['POST /'],
    timeout: 0,
  })
  async create(
    ctx: Context<
      { geojson: any; sourceSrid: number; targetSrid: number },
      {
        $responseType: string;
        $statusCode: number;
        $responseHeaders: any;
      }
    >,
  ) {
    const { geojson, sourceSrid, targetSrid } = ctx.params;

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

    // No-op when the caller asks for the same CRS on both sides — skip the
    // ogr2ogr round-trip (and the temp-file dance) entirely. The caller
    // still gets a stream so the response handling stays uniform.
    if (sourceSrid === targetSrid) {
      ctx.meta.$responseType = 'application/geo+json';
      ctx.meta.$statusCode = 200;
      // Wrap the buffer in a one-chunk stream to match the ogr2ogr path's
      // return shape. Caller pipes it to MinIO / response body either way.
      const { Readable } = await import('stream');
      return Readable.from([Buffer.from(JSON.stringify(geojson))]);
    }

    const workDir = await fsp.mkdtemp(join(tmpdir(), `reproject-`));
    const inPath = join(workDir, 'in.geojson');
    const outPath = join(workDir, 'out.geojson');

    try {
      await fsp.writeFile(inPath, JSON.stringify(geojson));

      // ogr2ogr GeoJSON -> GeoJSON with CRS transform. -s_srs declares the
      // input's spatial reference (GeoJSON spec defines CRS84 but biip uses
      // 3346 throughout); -t_srs is the desired output CRS.
      // Binary path is literal; inputs are paths inside our private workDir.
      await this.runOgr2Ogr([
        '-f',
        'GeoJSON',
        '-s_srs',
        `EPSG:${sourceSrid}`,
        '-t_srs',
        `EPSG:${targetSrid}`,
        outPath,
        inPath,
      ]);

      const stat = await fsp.stat(outPath);

      ctx.meta.$responseType = 'application/geo+json';
      ctx.meta.$statusCode = 200;
      ctx.meta.$responseHeaders = {
        'Content-Length': stat.size.toString(),
      };

      const stream = createReadStream(outPath);
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
}
