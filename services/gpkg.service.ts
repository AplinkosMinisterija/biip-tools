'use strict';

import moleculer from 'moleculer';
import { Action, Service } from 'moleculer-decorators';
import {
  GPKG_FORMAT,
  respondWithVectorExport,
  VectorExportContext,
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
  async create(ctx: VectorExportContext) {
    return respondWithVectorExport(ctx, GPKG_FORMAT, this.logger);
  }
}
