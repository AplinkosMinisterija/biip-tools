'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Service } from 'moleculer-decorators';
import { toReadableStream } from '../utils';

@Service({
  name: 'pdf',
})
export default class PdfService extends moleculer.Service {
  @Action({
    openapi: {
      summary: 'Generates a PDF of the page with the print CSS media type.',
      responses: {
        '200': {
          description: '',
          content: {
            'application/pdf': {
              schema: {
                type: 'string',
                format: 'binary',
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
      height: {
        type: 'number',
        convert: true,
        optional: true,
        $$t: 'Height of browser viewport',
        max: 4000,
        default: 877,
      },
      width: {
        type: 'number',
        convert: true,
        optional: true,
        $$t: 'Width of browser viewport',
        max: 4000,
        default: 620,
      },
      footer: {
        type: 'string',
        convert: true,
        optional: true,
        $$t: 'Footer template for page',
        default: '<span></span>',
      },
      header: {
        type: 'string',
        convert: true,
        optional: true,
        $$t: 'Header template for page',
        default: '<span></span>',
      },
      margin: {
        type: 'object',
        props: {
          top: {
            type: 'number',
            default: 50,
            convert: true,
            optional: true,
          },
          bottom: {
            type: 'number',
            default: 50,
            convert: true,
            optional: true,
          },
          left: {
            type: 'number',
            default: 50,
            convert: true,
            optional: true,
          },
          right: {
            type: 'number',
            default: 50,
            convert: true,
            optional: true,
          },
        },
        convert: true,
        optional: true,
        $$t: 'Margins in pixels',
      },
    },
    rest: ['POST /'],
    timeout: 0,
  })
  async create(
    ctx: Context<
      {
        url: string;
        height: number;
        width: number;
        footer: string;
        header: string;
        margin?: {
          top?: number;
          bottom?: number;
          left?: number;
          right?: number;
        };
      },
      {
        $responseType: string;
        $statusCode: number;
        $statusMessage: string;
      }
    >,
  ) {
    const host = process.env.CHROME_API_ENDPOINT || 'http://localhost:9321';
    const pdfUrl = `${host}/pdf`;

    const { url, height, width, margin, footer, header } = ctx.params;

    const options: any = {
      width: `${height}px`,
      height: `${width}px`,
      timeout: 1000 * 60 * 10,
      headerTemplate: header,
      footerTemplate: footer,
      displayHeaderFooter: true,
      format: 'A4',
      margin: {
        top: `${margin?.top || 50}px`,
        left: `${margin?.left || 50}px`,
        right: `${margin?.right || 50}px`,
        bottom: `${margin?.bottom || 50}px`,
      },
    };

    return fetch(pdfUrl, {
      method: 'POST',
      body: JSON.stringify({
        url,
        options,
        gotoOptions: {
          waitUntil: 'networkidle0',
          timeout: 600000,
        },
      }),
      headers: {
        'Content-Type': 'application/json',
      },
    })
      .then((response) => {
        ctx.meta.$responseType = response.headers.get('Content-Type');
        ctx.meta.$statusCode = response.status;
        ctx.meta.$statusMessage = response.statusText;

        return response;
      })
      .then((response) => response?.body?.getReader?.())
      .then((stream) => toReadableStream(stream));
  }
}
