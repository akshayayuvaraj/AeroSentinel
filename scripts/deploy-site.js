// Usage: npm run deploy:site -- <SiteBucketName> <DistributionId>   (needs AWS CLI configured)
const { execSync } = require('child_process');
const [bucket, dist] = process.argv.slice(2);
if (!bucket) { console.error('Usage: npm run deploy:site -- <SiteBucketName> [DistributionId]'); process.exit(1); }
execSync(`aws s3 sync public s3://${bucket} --delete`, { stdio: 'inherit' });
if (dist) execSync(`aws cloudfront create-invalidation --distribution-id ${dist} --paths "/*"`, { stdio: 'inherit' });
