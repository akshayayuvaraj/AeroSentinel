// Needs: npm i @codegenie/serverless-express (inside server/ before sam build)
const serverlessExpress = require('@codegenie/serverless-express');
exports.handler = serverlessExpress({ app: require('./server') });
