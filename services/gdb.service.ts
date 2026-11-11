'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Service } from 'moleculer-decorators';
import {
  GDB_FORMAT,
  VectorExportFeatureCollection,
  runVectorExport,
  VectorExportLayer,
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
      format: GDB_FORMAT,
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
