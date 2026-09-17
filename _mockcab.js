// Мини-сервер для проверки кабинета: заявка со счетами двух юрлиц.
const http = require('http'), fs = require('fs'), path = require('path');
let mockCats = [{id:1,name:'Насосы'},{id:2,name:'Трубы ПНД'},{id:3,name:'Фитинги'},{id:4,name:'Ёмкости и баки'},{id:5,name:'Фильтры'},{id:6,name:'Автоматика'}];
const j = (res, o, code) => { res.writeHead(code || 200, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(o)); };
const slots = [{
  id: 1, date: '2026-09-03', type: 'bulk', time_start: '10:00', time_end: '10:30',
  is_booked: 1, confirmed: 1, in_progress: 0, assembling: 0, completed: 0,
  customer_name: 'Иван Иванов', customer_phone: '79001112233',
  customer_account: '40817810000000000001\n40817810000000000002\n40817810000000000003',
  customer_organization: 'ООО «Ромашка», ООО «Василёк»',
  customer_comment: '', booked_at: '2026-09-03 09:15', confirmed_at: '2026-09-03 09:22',
  in_progress_at: null, assembling_at: null, completed_at: null,
  warehouse_id: 5, warehouse_name: 'Основной склад', storekeeper_name: '',
  vehicle_class_name: 'Газель', load_type_name: 'Задняя', tz_offset: 3,
  accounts: [
    { accountNumber: '40817810000000000001', organization: 'ООО «Ромашка»', managerName: 'Петров П. +79990001122', engineerName: 'Сидоров С.', comment: '', readyStatus: 1, notReadyReason: '' },
    { accountNumber: '40817810000000000002', organization: 'ООО «Ромашка»', managerName: '', engineerName: '', comment: 'срочно', readyStatus: 0, notReadyReason: '' },
    { accountNumber: '40817810000000000003', organization: 'ООО «Василёк»', managerName: '', engineerName: '', comment: '', readyStatus: 0, notReadyReason: 'нет на складе' }
  ]
}];
http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  if (p === '/' || p.endsWith('.html')) { try { const b = fs.readFileSync(path.join(__dirname,'public', p==='/'?'index.html':p)); res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); return res.end(b); } catch (e) { res.writeHead(404); return res.end(); } }
  if (p.endsWith('.css') || p.endsWith('.js')) { try { const b = fs.readFileSync(path.join(__dirname,'public'+p)); res.writeHead(200,{'Content-Type': p.endsWith('.css')?'text/css':'text/javascript'}); return res.end(b); } catch (e) { res.writeHead(404); return res.end(); } }
  if (p === '/logo.png') { try { const b = fs.readFileSync(path.join(__dirname,'logo.png')); res.writeHead(200,{'Content-Type':'image/png'}); return res.end(b); } catch (e) { res.writeHead(404); return res.end(); } }
  if (p === '/api/manager/login') return j(res, { success:true, id:1, username:'admin', firstName:'Главный', lastName:'Администратор', isAdmin:true });
  if (p === '/api/manager/me') return j(res, { id:1, username:'admin', firstName:'Главный', lastName:'Администратор', isAdmin:true, warehouseIds:[], permissions:{} });
  if (p === '/api/manager/slots') return j(res, { slots });
  if (p === '/api/manager/warehouses') return j(res, { warehouses: [
    {id:5,name:'Основной склад',address:'г. Видное, Белокаменное ш., 1',is_default:1,tz_offset:3,created_at:'2026-01-10T09:00:00',
     categories:[{id:1,name:'Насосы'},{id:2,name:'Трубы ПНД'},{id:3,name:'Фитинги'}]},
    {id:6,name:'Склад №2 (Юг)',address:'г. Домодедово, Логистическая ул., 7',is_default:0,tz_offset:'',created_at:'2026-02-01T09:00:00',
     categories:[{id:4,name:'Ёмкости и баки'}]},
    {id:7,name:'Склад №3 (транзит)',address:'',is_default:0,tz_offset:'',created_at:'2026-03-01T09:00:00',categories:[]}
  ] });
  if (p === '/api/manager/categories' && req.method === 'GET') return j(res, { categories: mockCats });
  if (p === '/api/manager/categories' && req.method === 'POST') {
    let b = ''; req.on('data', c => b += c);
    return req.on('end', () => {
      let name = '';
      try { name = (JSON.parse(b).name || '').trim(); } catch (e) {}
      if (!name) return j(res, { error: 'Название обязательно' }, 400);
      const exists = mockCats.find(c => c.name === name);
      if (exists) return j(res, { success: true, existed: true, category: exists });
      const cat = { id: mockCats.length + 1, name };
      mockCats.push(cat);
      j(res, { success: true, category: cat });
    });
  }
  if (false) return j(res, { categories: [
    {id:1,name:'Насосы'},{id:2,name:'Трубы ПНД'},{id:3,name:'Фитинги'},
    {id:4,name:'Ёмкости и баки'},{id:5,name:'Фильтры'},{id:6,name:'Автоматика'}] });
  if (p === '/api/manager/storekeepers') return j(res, { storekeepers: [] });
  if (p.startsWith('/api/manager/')) return j(res, {});
  return j(res, {}, 404);
}).listen(4340, () => console.log('мок кабинета на 4340'));
