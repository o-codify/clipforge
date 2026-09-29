import { PlatformClient } from './client.js';
import { HELP,parseCommand,commandPlan,execute } from './commands.js';

async function main() {
  const parsed=parseCommand(process.argv.slice(2));
  if(parsed.values.help||!parsed.positionals.length){process.stdout.write(HELP);return;}
  const plan=await commandPlan(parsed);
  const url=parsed.values.url??process.env.CLIPFORGE_URL;
  if(!url)throw new Error('Задайте --url или CLIPFORGE_URL');
  // Refuse a borrowed session when an argument switches to a different environment.
  if(process.env.CLIPFORGE_SESSION && (!process.env.CLIPFORGE_URL || new URL(url).origin!==new URL(process.env.CLIPFORGE_URL).origin)) {
    throw new Error('Сессия должна использоваться только с адресом из CLIPFORGE_URL');
  }
  const client=new PlatformClient(url,process.env.CLIPFORGE_SESSION);
  try {
    if(!process.env.CLIPFORGE_SESSION) {
      const login=process.env.CLIPFORGE_LOGIN,password=process.env.CLIPFORGE_PASSWORD;
      if(!login||!password)throw new Error('Задайте CLIPFORGE_LOGIN и CLIPFORGE_PASSWORD или CLIPFORGE_SESSION');
      await client.login(login,password);
    }
    const {result,exitCode}=await execute(client,plan);
    process.stdout.write(JSON.stringify(result,null,2)+'\n');process.exitCode=exitCode;
  } finally {
    await client.close().catch(()=>process.stderr.write('Не удалось закрыть временную сессию ClipForge.\n'));
  }
}
main().catch(error=>{
  let message=error instanceof Error?error.message:'Ошибка клиента';
  for(const secret of [process.env.CLIPFORGE_PASSWORD,process.env.CLIPFORGE_SESSION])if(secret)message=message.replaceAll(secret,'[скрыто]');
  process.stderr.write(JSON.stringify({error:message})+'\n');process.exitCode=1;
});
