// ============================================================================
// Swagger/OpenAPI Configuration
// ============================================================================

import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { config } from './config/index.js';

const swaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'TingaTalk Backend API',
    version: '2.0.0',
    description: 'TingaTalk video calling app backend API documentation',
    contact: {
      name: 'TingaTalk Team'
    }
  },
  servers: [
    {
      url: `http://localhost:${config.port}`,
      description: 'Local development'
    },
    {
      url: 'https://api.tingatalk.in',
      description: 'Production'
    }
  ],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'Firebase ID Token'
      },
      AdminApiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'x-admin-api-key'
      }
    }
  }
};

const options = {
  swaggerDefinition,
  apis: ['./src/features/**/*.routes.js', './docs/swagger.yaml']
};

let swaggerSpec = null;

export function getSwaggerSpec() {
  if (!swaggerSpec) {
    swaggerSpec = swaggerJsdoc(options);
  }
  return swaggerSpec;
}

export function setupSwagger(app) {
  const spec = getSwaggerSpec();
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(spec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'TingaTalk API Docs'
  }));

  // Raw JSON spec endpoint
  app.get('/api-docs.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(spec);
  });
}
