'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Service } from 'moleculer-decorators';
import {
  GPKG_FORMAT,
  VECTOR_EXPORT_TIMEOUT_MS,
  runVectorExport,
  VectorExportLayer,
  vectorExportParams,
} from '../utils/vector-export';

@Service({
  name: 'gpkg',
})
export default class GpkgService extends moleculer.Service {
  @Action({
    openapi: {
      summary: 'Converts a GeoJSON FeatureCollection to an OGC GeoPackage (.gpkg) file.',
      responses: {
        '200': {
          description: 'GeoPackage (SQLite) file.',
          content: {
            'application/geopackage+sqlite3': {
              schema: { type: 'string', format: 'binary' },
            },
          },
        },
      },
    },
    params: vectorExportParams,
    rest: ['POST /'],
    // Bound the request the same way the pipeline bounds itself; the
    // previous `timeout: 0` meant an export could never be abandoned.
    timeout: VECTOR_EXPORT_TIMEOUT_MS,
  })
  async create(
    ctx: Context<
      {
        geojson?: any;
        layers?: VectorExportLayer[];
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
    const { stream, size, filename, contentType } = await runVectorExport({
      ...ctx.params,
      format: GPKG_FORMAT,
      logger: this.logger,
    });

    ctx.meta.$responseType = contentType;
    ctx.meta.$statusCode = 200;
    ctx.meta.$responseHeaders = {
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': size.toString(),
    };

    return stream;
  }
}
