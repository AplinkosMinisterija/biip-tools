'use strict';

import Openapi from 'moleculer-auto-openapi';
import moleculer from 'moleculer';
import { Method, Service } from 'moleculer-decorators';
@Service({
  name: 'openapi',
  mixins: [Openapi],
  settings: {
    schemaPath: '/tools/openapi/openapi.json',
    uiPath: '/tools/openapi/ui',
    assetsPath: '/tools/openapi/assets',
    openapi: {
      info: {
        description: 'Tools used for BĮIP projects',
        version: process.env.VERSION,
        title: 'BĮIP Tools',
      },
      tags: [],
      components: {},
    },
  },
  actions: {
    generateDocs: {
      rest: 'GET /openapi.json',
    },
    ui: {
      rest: 'GET /ui',
    },
    assets: {
      rest: 'GET /assets/:file',
    },
  },
})
export default class OpenapiService extends moleculer.Service {
  @Method
  mergeObjects(orig: any = {}, toMerge: any = {}) {
    for (const key in toMerge) {
      orig[key] = {
        ...(orig[key] || {}),
        ...toMerge[key],
      };

      if (!toMerge[key]) {
        delete orig[key];
      }
    }
    return orig;
  }

  @Method
  async fetchAliasesForService(service: string) {
    const aliases: any[] = await this.broker.call(`${service}.listAliases`);
    return aliases.filter((item) => !item.actionName.includes('openapi.'));
  }

  async started() {
    // cleanup unused parts
    delete this.settings.commonPathItemObjectResponses['401'];
    delete this.settings.commonPathItemObjectResponses['422'];
    delete this.settings.openapi?.components?.schemas?.DbMixinList;
    delete this.settings.openapi?.components?.schemas?.DbMixinFindList;
    delete this.settings.openapi?.components?.schemas?.Item;
    delete this.settings.openapi?.components?.responses?.UnauthorizedError;
    delete this.settings.openapi?.components?.responses?.ValidationError;
    delete this.settings.openapi?.components?.responses?.ReturnedData;
  }
}
