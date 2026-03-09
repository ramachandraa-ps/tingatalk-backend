// ============================================================================
// Export Swagger/OpenAPI spec to static YAML and JSON files
// Usage: node scripts/export-swagger.js
// ============================================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { getSwaggerSpec } from '../src/swagger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.join(__dirname, '..', 'docs');

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const spec = getSwaggerSpec();

// Export JSON
const jsonPath = path.join(outputDir, 'swagger-generated.json');
fs.writeFileSync(jsonPath, JSON.stringify(spec, null, 2));
console.log(`Swagger JSON exported to: ${jsonPath}`);

// Export YAML
const yamlPath = path.join(outputDir, 'swagger-generated.yaml');
fs.writeFileSync(yamlPath, yaml.dump(spec, { lineWidth: 120 }));
console.log(`Swagger YAML exported to: ${yamlPath}`);
