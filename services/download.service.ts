'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Service } from 'moleculer-decorators';
import { toReadableStream } from '../utils';

@Service({
  name: 'download',
})
export default class DownloadService extends moleculer.Service {
  @Action({
    openapi: {
      summary: 'Downloads file from any url.',
      responses: {
        '200': {
          description: '',
          content: {
            'application/json': {
              schema: {
                type: 'string',
                format: 'base64',
              },
            },
          },
        },
      },
    },
    params: {
      url: {
        type: 'url',
        $$t: 'Content URL',
      },
      name: {
        type: 'string',
        $$t: 'Filename',
      },
    },
    rest: ['GET /'],
    timeout: 0,
  })
  async download(
    ctx: Context<
      {
        url: string;
        name: string;
      },
      {
        $responseType: string;
        $statusCode: number;
        $statusMessage: string;
        $responseHeaders: any;
      }
    >,
  ) {
    const { url, name } = ctx.params;

    return fetch(url)
      .then((response) => {
        ctx.meta.$responseType = response.headers.get('Content-Type');
        ctx.meta.$statusCode = response.status;
        ctx.meta.$responseHeaders = {
          'Content-Disposition': `attachment; filename="${name}"`,
        };

        return response;
      })
      .then((response) => response?.body?.getReader?.())
      .then((stream) => toReadableStream(stream))
      .catch((err) => this.broker.logger.error(err));
  }
}
