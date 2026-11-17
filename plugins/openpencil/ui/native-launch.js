// Standalone App entrypoints may have no chat directory. Ask this same chat to
// bind one explicit launch request, never guess a process cwd or latest document.
const nativeLaunch = (() => {
  const value = result => result.structuredContent ?? JSON.parse(result.content.find(c=>c.type==='text').text);
  let pending;
  async function connect({call,request,capabilities}) {
    if(pending) return pending;
    pending=(async()=>{
      // A host that exposes this chat's MCP root can bind directly. Never fall
      // back to a model request after an ambiguous or failed mutation.
      try {
        const opened = await call('open_canvas');
        const session = opened._meta?.canvasSession;
        if (!session?.projectRoot || !session?.sessionId) throw Error('Редактор открыт, но Codex не передал его сеанс. Переоткройте панель.');
        return session;
      } catch (error) {
        if (!['PROJECT_ROOT_REQUIRED','PROJECT_ROOT_AMBIGUOUS','MCP_ROOTS_UNAVAILABLE'].includes(error.code)) throw error;
      }
      if(!capabilities.message?.text) throw Error('Этот режим Codex не позволяет подключить панель к чату. Напишите в текущем чате «Открой OpenBrush».');
      const launch=value(await call('canvas_launch_prepare'));
      const context={launchId:launch.launchId,instruction:'Call open_canvas with this launchId and projectRoot from the current chat working directory. Do not ask the user for a folder. Reuse the current canvas or choose the existing project document; do not create a new empty draft if the project already has the requested design.'};
      let prompt='Открой OpenBrush для текущего проекта и подключи панель к этому чату.';
      if(capabilities.updateModelContext) await request('ui/update-model-context',{structuredContent:{openBrushLaunch:context}});
      else prompt+=`\nКод подключения OpenBrush: ${launch.launchId}`;
      document.getElementById('boot-status').textContent='Подключаем OpenBrush к папке этого чата…';
      const sent=await request('ui/message',{role:'user',content:[{type:'text',text:prompt}]});
      if(sent?.isError) throw Error('Codex не принял запрос подключения. Повторной отправки не было.');
      while(Date.now()<Date.parse(launch.expiresAt)) {
        const result=value(await call('canvas_launch_poll',{launchId:launch.launchId}));
        if(result.state==='ready') return result.canvasSession;
        if(result.state==='expired') break;
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
      throw Error('Время подключения истекло. Напишите «Открой OpenBrush» в этом чате.');
    })();
    return pending;
  }
  return {connect};
})();
