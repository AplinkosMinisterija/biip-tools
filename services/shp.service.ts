'use strict';

import moleculer from 'moleculer';
import { Action, Service } from 'moleculer-decorators';
import {
  SHP_FORMAT,
  respondWithVectorExport,
  VectorExportContext,
  vectorExportParams,
} from '../utils/vector-export';

@Service({
  name: 'shp',
})
export default class ShpService extends moleculer.Service {
  @Action({
    openapi: {
      summary:
        'Converts GeoJSON FeatureCollections to ESRI Shapefiles (one per layer) in a ZIP archive.',
      responses: {
        '200': {
          description: 'ZIP archive holding one shapefile file set per layer.',
          content: {
            'application/zip': {
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
    return respondWithVectorExport(ctx, SHP_FORMAT, this.logger);
  }
}
