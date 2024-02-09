'use strict';

import moleculer from 'moleculer';
import { Service } from 'moleculer-decorators';

import DbConnection from '../mixins/database.mixin';

import PostgisMixin from 'moleculer-postgis';
import { boundariesConfig } from '../knexfile';

@Service({
  name: 'boundaries.counties',

  mixins: [
    DbConnection({
      collection: 'counties',
      config: boundariesConfig,
      rest: '/boundaries/counties',
      createActions: {
        create: false,
        replace: false,
        update: false,
        remove: false,
        get: false,
        createMany: false,
        removeAllEntities: false,
      },
    }),
    PostgisMixin({
      srid: 3346,
    }),
  ],

  settings: {
    fields: {
      id: {
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
      code: 'string',
      area: 'number',
    },
  },
})
export default class BoundariesCountiesService extends moleculer.Service {}
