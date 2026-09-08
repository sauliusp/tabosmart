import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstallationWelcome } from '../extension/installation.mjs';
function fixture() {
  const local = {}, tabs = [], created = [];
  let fail = false;
  const api = {
    runtime: { getURL: path => `chrome-extension://test/${path}` },
    storage: { local: { get: async key => ({ [key]: local[key] }), set: async value => Object.assign(local, value) } },
    tabs: { query: async () => tabs, create: async props => { if (fail) throw Error('No window available'); created.push(props); tabs.push({ ...props, id: 1 }); } },
  };
  return { api, local, tabs, created, setFail: value => { fail = value; } };
}
test('fresh installation opens exactly one internal welcome tab, including concurrent events and worker restart', async () => {
  const f = fixture(); const installed = createInstallationWelcome(f.api);
  await Promise.all([installed({reason:'install'}), installed({reason:'install'})]);
  assert.deepEqual(f.created, [{url:'chrome-extension://test/welcome.html', active:true}]);
  f.tabs.length = 0;
  await createInstallationWelcome(f.api)({reason:'install'});
  assert.equal(f.created.length, 1);
});
test('updates, browser updates and missing install details never open a tab', async () => {
  const f=fixture(); const installed=createInstallationWelcome(f.api);
  for (const details of [{reason:'update'}, {reason:'chrome_update'}, {reason:'shared_module_update'}, undefined]) await installed(details);
  assert.equal(f.created.length,0);
  assert.deepEqual(f.local,{});
});
test('a welcome tab already open is reused without creating or focusing another', async () => {
  const f=fixture();f.tabs.push({url:'chrome-extension://test/welcome.html',incognito:false});
  await createInstallationWelcome(f.api)({reason:'install'});
  assert.equal(f.created.length,0);
  assert.equal(f.local['tabosmart.installWelcomeShown'],true);
});
test('failed tab creation does not record a successful welcome and can be retried', async () => {
  const f=fixture();const installed=createInstallationWelcome(f.api);f.setFail(true);
  await assert.rejects(installed({reason:'install'}));
  assert.deepEqual(f.local,{});
  f.setFail(false); await installed({reason:'install'});
  assert.equal(f.created.length,1);
});
