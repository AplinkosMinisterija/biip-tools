'use strict';

import moleculer from 'moleculer';
import { Service } from 'moleculer-decorators';

import DbConnection from '../mixins/database.mixin';

import PostgisMixin from 'moleculer-postgis';
import { boundariesConfig } from '../knexfile';

@Service({
  name: 'boundaries.municipalities',

  mixins: [
    DbConnection({
      collection: 'municipalities',
      config: boundariesConfig,
      rest: '/boundaries/municipalities',
      createActions: {
        create: false,
        replace: false,
        update: false,
        remove: false,
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
      countyCode: 'string',
    },
  },
})
export default class BoundariesMunicipalitiesService extends moleculer.Service {}
