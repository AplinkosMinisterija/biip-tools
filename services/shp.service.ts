'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Service } from 'moleculer-decorators';
import {
  SHP_FORMAT,
  VECTOR_EXPORT_TIMEOUT_MS,
  runVectorExport,
  VectorExportLayer,
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
      format: SHP_FORMAT,
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
