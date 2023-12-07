'use strict';

import moleculer from 'moleculer';
import { Action, Service } from 'moleculer-decorators';

@Service({
  name: 'ping',
})
export default class PingService extends moleculer.Service {
  @Action({
    rest: 'GET /',
    openapi: {
      summary: 'Health check',
      responses: {
        '200': {
          description: '',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  timestamp: {
                    example: Date.now(),
                    type: 'number',
                    description: 'Timestamp',
                  },
                },
              },
            },
          },
        },
      },
    },
  })
  ping() {
    return {
      timestamp: Date.now(),
    };
  }
}
