'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Service } from 'moleculer-decorators';
import { IMAGE_FILE_EXTENTIONS } from '../types';
import { toReadableStream } from '../utils';

@Service({
  name: 'screenshot',
})
export default class ScreenshotService extends moleculer.Service {
  @Action({
    openapi: {
      summary:
        'Creates a new PNG or JPEG image using the supplied JSON body for parameters, and returns the screenshot.',
      responses: {
        '200': {
          description: '',
          content: {
            'image/png': {
              schema: {
                type: 'string',
                format: 'binary',
              },
            },
            'image/jpeg': {
              schema: {
                type: 'string',
                format: 'binary',
              },
            },
            'text/plain; charset=utf-8': {
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
      encoding: {
        type: 'string',
        optional: true,
        default: 'binary',
        $$t: 'Returns image (binary) or string (base64)',
        enum: ['binary', 'base64'],
      },
      waitFor: {
        type: 'string',
        optional: true,
        convert: true,
        positive: true,
        $$t: 'Time or document selector before making screenshot',
      },
      height: {
        type: 'number',
        convert: true,
        optional: true,
        $$t: 'Height of browser viewport',
        max: 4000,
        default: 720,
      },
      width: {
        type: 'number',
        convert: true,
        optional: true,
        $$t: 'Width of browser viewport',
        max: 4000,
        default: 1280,
      },
      quality: {
        type: 'number',
        convert: true,
        $$t: 'Quality for jpeg',
        optional: true,
        default: 80,
        min: 0,
        max: 100,
      },
      type: {
        type: 'string',
        default: 'jpeg',
        $$t: 'Image format',
        enum: Object.keys(IMAGE_FILE_EXTENTIONS),
      },
      fullPage: {
        type: 'boolean',
        $$t: 'Enables full page screenshots',
        convert: true,
        default: false,
      },
    },
    rest: ['GET /'],
    timeout: 0,
  })
  async get(
    ctx: Context<
      {
        url: string;
        height: number;
        width: number;
        fullPage: boolean;
        type: string;
        quality: number;
        waitFor?: string | number;
        encoding: string;
      },
      {
        $responseType: string;
        $statusCode: number;
        $statusMessage: string;
      }
    >,
  ) {
    const host = process.env.CHROME_API_ENDPOINT || 'http://localhost:9321';
    const screenshotUrl = `${host}/screenshot`;

    const { url, height, width, fullPage, type, quality, encoding, waitFor } = ctx.params;

    const options: any = {
      type,
      fullPage,
      encoding,
    };

    if (type === 'jpeg') {
      options.quality = quality;
    }

    return fetch(screenshotUrl, {
      method: 'POST',
      body: JSON.stringify({
        url,
        viewport: {
          height,
          width,
        },
        options,
        gotoOptions: {
          waitUntil: 'networkidle0',
          timeout: 600000,
        },
        waitFor,
      }),
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
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
