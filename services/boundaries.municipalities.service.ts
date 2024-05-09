'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Service } from 'moleculer-decorators';

import DbConnection from '../mixins/database.mixin';

import PostgisMixin from 'moleculer-postgis';
import { boundariesConfig } from '../knexfile';
import { CREATE_ONLY_READ_ACTIONS } from '../types';

@Service({
  name: 'boundaries.municipalities',

  mixins: [
    DbConnection({
      collection: 'municipalities',
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
        columnName: 'code',
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
      county: {
        type: 'string',
        columnName: 'countyCode',
        populate: (ctx: Context, values: string[]) =>
          ctx.call('boundaries.counties.resolve', { code: values, mapping: true }),
      },
    },
  },
})
export default class BoundariesMunicipalitiesService extends moleculer.Service {}
