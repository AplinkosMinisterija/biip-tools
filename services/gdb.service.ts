'use strict';

import moleculer from 'moleculer';
import { Action, Service } from 'moleculer-decorators';
import {
  GDB_FORMAT,
  respondWithVectorExport,
  VectorExportContext,
  vectorExportParams,
} from '../utils/vector-export';

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
    params: vectorExportParams,
    rest: ['POST /'],
    // A conversion of real size is never cut short.
    timeout: 0,
  })
  async create(ctx: VectorExportContext) {
    return respondWithVectorExport(ctx, GDB_FORMAT, this.logger);
  }
}
