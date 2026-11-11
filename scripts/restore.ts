import { ensure } from '../packages/contracts/foundation.ts';
import { restoreBackup } from '../packages/infra/recovery.ts';

const [source, destination] = process.argv.slice(2);
ensure(source && destination, 'VALIDATION', '用法：npm run restore -- 备份目录 新数据目录');
console.log(JSON.stringify(restoreBackup(source, destination)));
