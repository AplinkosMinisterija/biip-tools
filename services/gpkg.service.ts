'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Service } from 'moleculer-decorators';
import {
  GPKG_FORMAT,
  VectorExportFeatureCollection,
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
    // A conversion of real size is never cut short.
    timeout: 0,
  })
  async create(
    ctx: Context<
      {
        geojson?: VectorExportFeatureCollection;
        layers?: VectorExportLayer[];
        srid: number;
        name: string;
      },
      {
        $responseType: string;
        $statusCode: number;
        $responseHeaders: Record<string, string>;
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
