# 部署到腾讯云开发 CloudBase

CloudBase 现在给 Next.js 这类有构建步骤的应用推荐的部署方式是**云托管(CloudBase Run)**——按你的 Dockerfile 把应用打成容器跑起来,不是老的云函数框架。数据库用 CloudBase 自带的 **MySQL**,开一次「直连服务」拿到标准连接串,和本项目 `lib/db.ts` 已经在用的 `mysql2` 驱动完全兼容,**不需要改一行代码**。

全程不需要自己的域名也能跑起来(CloudBase Run 会给一个默认域名),想换自己域名再去走 ICP 备案即可,详见文末。

---

## 第一步:装 CLI,登录

```bash
npm i -g @cloudbase/cli
# 如果网络超时(ETIMEOUT / network request failed):
# npm i -g @cloudbase/cli --registry=http://mirrors.cloud.tencent.com/npm/

tcb login
```
`tcb login` 会打开浏览器授权;如果是在没有浏览器的服务器/容器里跑,CLI 会自动切成扫码/输码授权,照着终端提示的链接和验证码操作即可。

## 第二步:开一个云开发环境

打开 **https://tcb.cloud.tencent.com/dev**,登录后点「新建环境」,选按量计费或体验版都行(体验版有免费额度,先测试够用)。记下环境 ID(形如 `your-env-abc123`),后面处处要用。

## 第三步:开 MySQL 数据库,拿直连地址

新建的环境里,MySQL 数据库需要手动开一次(免费额度内)。**注意一个关键点**:CloudBase 自带的 MySQL 型数据库默认不对外暴露 IP/端口,所有访问都走它自己的网关(给小程序/前端 SDK 用),本项目走的是标准 `mysql://` 协议直连,所以要单独开一个「直连服务」开关。

1. 控制台左侧「云数据库」→「MySQL」,没开过就先创建一个实例。
2. 进入「数据库设置」→ 找到「直连服务」模块,点**启用**。
3. 启用后会生成**内网地址**和**外网地址**两种连接方式。CloudBase Run 和数据库在同一环境下,建议用**内网地址**(延迟低、不走公网);本地调试可以先用外网地址试连。
4. 如果还没建数据库账号,先在「账号管理」建一个,拿到用户名密码。

拼接连接串(标准 MySQL 格式,和自建/其他云 MySQL 完全一样):
```
mysql://<username>:<password>@<host>:<port>/<database>
```
这就是 `DATABASE_URL`。

> 已经有一个独立的腾讯云数据库 MySQL(CDB)实例,不想用 CloudBase 自带的?也可以——云托管服务创建时把「云托管网络」选成 CDB 实例所在的 VPC,就能用内网地址直连,连接串格式一样。但要注意**云托管目前只支持上海、广州、北京三个地域**,CDB 实例必须在同一地域才能复用同一 VPC。



## 第四步:确认 Dockerfile(项目里已经有)

repo 根目录的 `Dockerfile` 已经是多阶段构建、`EXPOSE 80`、`CMD ["npm","start"]`,跟 CloudBase Run 的要求完全对得上,不需要改。如果你用的是我们之前给的 `docker-compose.yml` 那套自托管方案,**部署到 CloudBase Run 时不需要 `docker-compose.yml`**,云托管只吃 `Dockerfile`,数据库换成上一步的 CloudBase MySQL,不再需要 compose 里那个数据库容器。

## 第五步:部署到云托管(CloudBase Run)

两种方式选一种。

### 方式 A:控制台上传(最直观)

1. 控制台左侧「云托管」→「新建服务」。
2. 部署方式选**上传代码包**,代码包类型选**文件夹**,选中项目根目录上传(会自动识别 `Dockerfile`)。
3. 端口填 **80**(容器监听 80,CloudBase 健康探针默认也走 80,必须一致)。
4. 环境变量加三个(下一步详细说):`DATABASE_URL`、`ADMIN_TOKEN`、`BGM_USER_AGENT`。
5. 点创建,等构建完成。

### 方式 B:CLI 一条命令(适合以后重复部署)

项目根目录下:
```bash
tcb cloudrun deploy -p 80
```
CLI 会提示你选择环境和服务名,自动打包、上传、构建、上线。以后改完代码,同一条命令重新跑一遍就是更新部署。

### 方式 C:关联 GitHub 仓库(自动化程度最高)

控制台「云托管」→「新建服务」→ 部署方式选**代码仓库**,授权你的 GitHub,选中 `bgm-saimoe` 仓库和分支,填端口 80。以后 `git push` 到该分支,CloudBase 会自动重新构建部署,不用手动操作。这条最接近 Vercel 的体验。

## 第六步:配置环境变量

不管用哪种部署方式,都要在云托管服务的「环境变量」里加:

| 变量名 | 值 |
|---|---|
| `DATABASE_URL` | 第三步拼好的连接串 |
| `ADMIN_TOKEN` | 一段随机长字符串,例如 `openssl rand -hex 24` 生成的 |
| `BGM_USER_AGENT` | `bgm-saimoe/1.0`(可选,不填也行) |

改完环境变量要重新部署一次才生效(控制台有「重新部署」按钮,或者再跑一次 `tcb cloudrun deploy`)。

## 第七步:验证

1. 云托管服务详情页会给一个默认域名,形如 `https://xxx-xxx.ap-shanghai.run.tcloudbase.com`,直接能访问,**不需要备案**。
2. 打开后应该看到「比赛还没开始」——说明 `ensureSchema()` 已经在这次请求里自动把五张表建好了。
3. 访问同域名的 `/admin`,输入你设的 `ADMIN_TOKEN`,创建一届比赛试试。
4. 回主页搜角色、提名、投票,确认票数正常变化。

## 换成自己的域名(可选,要备案)

CloudBase Run 支持绑定自定义域名,但和其他大陆服务一样,**自己的域名必须先完成 ICP 备案**才能生效。备案在腾讯云控制台可以免费代办,通常 1~2 周。备案通过后,在云托管服务的「域名管理」里绑定,DNS 加一条 CNAME 指到控制台给的地址即可,HTTPS 证书 CloudBase 会帮你处理。

## 后续更新代码怎么办

- 方式 B(CLI):改完代码,`tcb cloudrun deploy -p 80` 重新跑一遍。
- 方式 C(GitHub 关联):直接 `git push`,自动重新部署。

## 已知要留意的点

- **CloudBase Run 目前跑 Next.js 只支持上海地域**,建环境和建云托管服务时region 都选上海即可,别选别的地域导致找不到对应能力。
- CloudBase 自带的 MySQL 型数据库默认走网关(给小程序/前端 SDK 用),**本项目走的是纯服务端标准协议直连**,所以必须先手动开「直连服务」那个开关,否则拿到的地址连不上。
- 直连账号建议单独建一个,只给建表/读写所需的最小权限;别拿云开发的超级管理员账号去连生产应用。
- 免费/按量档位有连接数和资源上限,人气投票这种量级足够;真的要处理高并发,再考虑升配。
