'use strict';

import moleculer, { Context } from 'moleculer';
import { Service } from 'moleculer-decorators';

import DbConnection from '../mixins/database.mixin';

import PostgisMixin from 'moleculer-postgis';
import { boundariesConfig } from '../knexfile';
import { CREATE_ONLY_READ_ACTIONS } from '../types';

@Service({
  name: 'boundaries.residentialAreas',

  mixins: [
    DbConnection({
      collection: 'residentialAreas',
      config: boundariesConfig,
      createActions: CREATE_ONLY_READ_ACTIONS,
    }),
    PostgisMixin({
      srid: 3346,
    }),
  ],

  settings: {
    fields: {
      code: {
        type: 'string',
        columnType: 'integer',
        primaryKey: true,
        secure: true,
      },

      geom: {
        type: 'any',
        geom: {
          type: 'geom',
        },
      },

      name: 'string',
      area: 'number',
      municipality: {
        type: 'string',
        columnName: 'municipalityCode',
        populate: (ctx: Context, values: string[]) =>
          ctx.call('boundaries.municipalities.resolve', { code: values, mapping: true }),
      },
    },
  },
})
export default class BoundariesResidentialAreasService extends moleculer.Service {}
