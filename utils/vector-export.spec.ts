import {
  MAX_LAYERS,
  MAX_TOTAL_FEATURES,
  resolveVectorExportLayers,
  VectorExportLayer,
} from './vector-export';

const featureCollection = (featureCount = 1) => ({
  type: 'FeatureCollection',
  features: Array.from({ length: featureCount }, () => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [0, 0] },
    properties: {},
  })),
});

const layer = (name: string, featureCount = 1): VectorExportLayer => ({
  name,
  geojson: featureCollection(featureCount),
});

// Layers share one FeatureCollection instance so a large count stays cheap —
// resolveVectorExportLayers only reads features.length.
const manyLayers = (count: number, featureCount = 1): VectorExportLayer[] => {
  const geojson = featureCollection(featureCount);
  return Array.from({ length: count }, (_, i) => ({ name: `layer_${i}`, geojson }));
};

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e: any) {
    return e.type;
  }
  return undefined;
};

describe('resolveVectorExportLayers', () => {
  describe('input shapes', () => {
    it('wraps single-layer `geojson` into one layer named after the export', () => {
      expect(resolveVectorExportLayers({ geojson: featureCollection(), name: 'extract' })).toEqual([
        { name: 'extract', geojson: featureCollection() },
      ]);
    });

    it('passes `layers` through untouched', () => {
      const layers = [layer('places'), layer('observations')];
      expect(resolveVectorExportLayers({ layers, name: 'extract' })).toBe(layers);
    });

    it('prefers `layers` when both shapes are supplied', () => {
      const layers = [layer('places')];
      expect(
        resolveVectorExportLayers({ layers, geojson: featureCollection(), name: 'extract' }),
      ).toBe(layers);
    });

    it('rejects a request with neither shape', () => {
      expect(codeOf(() => resolveVectorExportLayers({ name: 'extract' }))).toBe('NO_INPUT');
    });

    it('rejects an empty layers array', () => {
      expect(codeOf(() => resolveVectorExportLayers({ layers: [], name: 'extract' }))).toBe(
        'NO_INPUT',
      );
    });
  });

  describe('geojson validation', () => {
    it('rejects a layer whose geojson is not a FeatureCollection', () => {
      const layers = [{ name: 'places', geojson: { type: 'Feature' } }];
      expect(codeOf(() => resolveVectorExportLayers({ layers, name: 'extract' }))).toBe(
        'INVALID_GEOJSON',
      );
    });

    it('rejects a layer with no features', () => {
      expect(codeOf(() => resolveVectorExportLayers({ layers: [layer('places', 0)], name: 'x' }))).toBe(
        'EMPTY_FEATURES',
      );
    });
  });

  describe('resource limits', () => {
    it('accepts exactly MAX_LAYERS', () => {
      const layers = manyLayers(MAX_LAYERS);
      expect(resolveVectorExportLayers({ layers, name: 'extract' })).toHaveLength(MAX_LAYERS);
    });

    it('rejects MAX_LAYERS + 1 — each layer costs one GDAL process', () => {
      const layers = manyLayers(MAX_LAYERS + 1);
      expect(codeOf(() => resolveVectorExportLayers({ layers, name: 'extract' }))).toBe(
        'TOO_MANY_LAYERS',
      );
    });

    it('accepts exactly MAX_TOTAL_FEATURES', () => {
      const layers = [layer('places', MAX_TOTAL_FEATURES)];
      expect(resolveVectorExportLayers({ layers, name: 'extract' })).toHaveLength(1);
    });

    it('rejects MAX_TOTAL_FEATURES + 1', () => {
      const layers = [layer('places', MAX_TOTAL_FEATURES + 1)];
      expect(codeOf(() => resolveVectorExportLayers({ layers, name: 'extract' }))).toBe(
        'TOO_MANY_FEATURES',
      );
    });

    it('counts features across layers, not per layer', () => {
      const half = Math.ceil(MAX_TOTAL_FEATURES / 2) + 1;
      const layers = [layer('a', half), layer('b', half)];
      expect(codeOf(() => resolveVectorExportLayers({ layers, name: 'extract' }))).toBe(
        'TOO_MANY_FEATURES',
      );
    });
  });

  describe('duplicate layer names', () => {
    it('rejects an exact duplicate', () => {
      const layers = [layer('places'), layer('places')];
      expect(codeOf(() => resolveVectorExportLayers({ layers, name: 'extract' }))).toBe(
        'DUPLICATE_LAYER',
      );
    });

    // GPKG layer names become SQLite table names and SQLite identifiers are
    // case-insensitive, so these two would silently merge into one table.
    it('rejects a case-only duplicate', () => {
      const layers = [layer('roads'), layer('Roads')];
      expect(codeOf(() => resolveVectorExportLayers({ layers, name: 'extract' }))).toBe(
        'DUPLICATE_LAYER',
      );
    });

    it('allows names that differ by more than case', () => {
      const layers = [layer('roads'), layer('roads_2')];
      expect(resolveVectorExportLayers({ layers, name: 'extract' })).toHaveLength(2);
    });
  });
});
