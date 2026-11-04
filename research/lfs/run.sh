#!/bin/zsh
# 大附件 / Git LFS 本机实验（Ticket #13）。
# 用法：research/lfs/run.sh <scratch 目录>；测试仓库与大文件都只写在 scratch 目录里，不进本仓库。
# 前置：系统 git（ADR 0004）+ brew 安装的 git-lfs；不改全局 git 配置，LFS 只用 `git lfs install --local`。
set -eu
zmodload zsh/datetime

S=${1:?usage: run.sh <scratch-dir>}
NOTES=${NOTES:-1000}        # 笔记数
ATT1=${ATT1:-200}           # 第 1 次提交的附件数
ATT2=${ATT2:-100}           # 第 2 次提交新增的附件数（同时删掉 50 个旧附件）
MB=${MB:-1}                 # 每个附件大小（MB，随机内容，不可压缩）
NOLFS_PATH=/usr/bin:/bin:/usr/sbin:/sbin   # 不含 /opt/homebrew/bin，模拟“没装 git-lfs”

rm -rf "$S"; mkdir -p "$S"; cd "$S"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

# 计时：打印毫秒
t() { local s=$EPOCHREALTIME; "$@" >/dev/null 2>&1; printf '%.0f' $(( (EPOCHREALTIME - s) * 1000 )); }
# 5 次取中位数
med() { local a=(); for i in 1 2 3 4 5; do a+=$(t "$@"); done; a=(${(n)a}); echo ${a[3]}; }
size() { du -sk "$1" | awk '{printf "%.0f MB", $1/1024}'; }

# 生成同一份内容池，两个仓库用完全相同的文件
mkdir -p pool/notes pool/att
for i in $(seq 1 $NOTES); do printf '# note %d\n\n%s\n' $i "$(head -c 1500 /dev/urandom | base64)" > pool/notes/n$i.md; done
for i in $(seq 1 $((ATT1 + ATT2))); do
  head -c $((MB * 1048576)) /dev/urandom > pool/tmp
  h=$(shasum -a 256 pool/tmp | cut -c1-16)   # 按内容哈希命名（模拟 #8 的去重）
  mv pool/tmp pool/att/$(printf '%04d' $i)-$h.bin
done
ATTS=($S/pool/att/*)

build() { # $1 = 仓库名, $2 = lfs|plain
  git init -q -b main $1; cd $1
  if [[ $2 == lfs ]]; then
    git lfs install --local >/dev/null
    git lfs track 'attachments/**' >/dev/null
  fi
  mkdir -p notes attachments
  cp ../pool/notes/* notes/
  for f in ${ATTS[1,$ATT1]}; do cp $f attachments/; done
  local s=$EPOCHREALTIME
  git add -A && git commit -qm c1
  for f in ${ATTS[1,50]}; do git rm -q attachments/${f:t}; done   # 孤儿附件 git rm（#8）
  for f in ${ATTS[$((ATT1+1)),-1]}; do cp $f attachments/; done
  git add -A && git commit -qm c2
  printf '%s add+commit=%.0f ms\n' $1 $(( (EPOCHREALTIME - s) * 1000 ))
  git gc -q   # 打包，接近 push 后的服务端形态
  cd ..
}

echo "== 构建（$NOTES 笔记，附件 ${ATT1}+${ATT2} 个 × ${MB} MB，删除 50 个）"
build plain plain
build lfs lfs

echo "\n== .git 体积"
echo "plain/.git            $(size plain/.git)"
echo "lfs/.git              $(size lfs/.git)（其中 .git/lfs $(size lfs/.git/lfs)）"
echo "lfs/.git 去掉 lfs/      $(du -sk -I lfs lfs/.git | awk '{printf "%.0f MB", $1/1024}')"

echo "\n== file:// clone（强制走 pack 传输，不用硬链接）"
echo "plain clone           $(t git clone -q file://$S/plain c-plain) ms, .git $(size c-plain/.git)"
echo "lfs clone (有 lfs)    $(t git clone -q -c filter.lfs.process='git-lfs filter-process' -c filter.lfs.required=true -c filter.lfs.smudge='git-lfs smudge -- %f' -c filter.lfs.clean='git-lfs clean -- %f' file://$S/lfs c-lfs) ms, .git $(size c-lfs/.git)"
echo "lfs clone SKIP_SMUDGE $(GIT_LFS_SKIP_SMUDGE=1 t git clone -q -c filter.lfs.process='git-lfs filter-process' -c filter.lfs.required=true -c filter.lfs.smudge='git-lfs smudge -- %f' -c filter.lfs.clean='git-lfs clean -- %f' file://$S/lfs c-lfs-skip) ms, .git $(size c-lfs-skip/.git), 工作区 attachments $(size c-lfs-skip/attachments)"
echo "lfs clone 无 lfs      $(PATH=$NOLFS_PATH t git clone -q file://$S/lfs c-lfs-nolfs) ms, .git $(size c-lfs-nolfs/.git), 工作区 attachments $(size c-lfs-nolfs/attachments)"
( cd plain && git config uploadpack.allowFilter true )
echo "partial clone blob:limit=100k  $(t git clone -q --filter=blob:limit=100k file://$S/plain c-partial) ms（含 checkout 按需拉 HEAD 附件）, .git $(size c-partial/.git)"

echo "\n== 无 lfs 时 checkout 的结果"
f=$(ls c-lfs-nolfs/attachments | head -1)
echo "c-lfs-nolfs/attachments/$f:"; head -c 200 c-lfs-nolfs/attachments/$f; echo
echo "git status（无 lfs，无 filter 配置）: $(cd c-lfs-nolfs && git status --porcelain | wc -l | tr -d ' ') 行变更"
# 仓库已配置 filter（如用户全局 git lfs install 过）但 PATH 里没有 git-lfs
cp -R c-lfs-nolfs c-lfs-required
( cd c-lfs-required && git config filter.lfs.process 'git-lfs filter-process' && git config filter.lfs.required true \
  && rm attachments/$f && PATH=$NOLFS_PATH git checkout -- attachments/$f 2>&1 | head -3; echo "exit=$pipestatus[1]" )
( cd c-lfs-required && echo "status: $(PATH=$NOLFS_PATH git status --porcelain 2>&1 | head -3)" )
# 无 lfs 时在 LFS 仓库里新增附件并提交：会作为普通 blob 进仓库（在副本里做，不影响后面读 HEAD~1）
cp -R c-lfs-nolfs c-lfs-nolfs-add
( cd c-lfs-nolfs-add && head -c 1048576 /dev/urandom > attachments/new-nolfs.bin && PATH=$NOLFS_PATH git add attachments/new-nolfs.bin \
  && git commit -qm nolfs && echo "无 lfs 新增附件入库形态: $(git cat-file -s HEAD:attachments/new-nolfs.bin) 字节 blob（真实内容，而非指针）" )
( cd c-lfs && echo "有 lfs 的 clone: git lfs fsck → $(git lfs fsck 2>&1 | tail -1)；.git/hooks 里 pre-push: $(ls .git/hooks | grep -c '^pre-push$') 个" )
( cd c-lfs-skip && echo "SKIP_SMUDGE clone 的 git status: $(git status --porcelain | wc -l | tr -d ' ') 行变更" )

echo "\n== git status 耗时（中位数，5 次）"
for r in plain lfs c-lfs-skip; do echo "$r clean        $(cd $r && med git status --porcelain=v2 -uall) ms"; done
for r in plain lfs; do
  ( cd $r && touch attachments/*
    a=$(t git status --porcelain=v2 -uall); b=$(t git status --porcelain=v2 -uall)
    git update-index -q --refresh; sleep 2; git update-index -q --refresh
    echo "$r touch 全部附件后：第 1 次 $a ms，第 2 次 $b ms，refresh 后 $(med git status --porcelain=v2 -uall) ms" )
done

echo "\n== cat-file --batch 读历史附件（被 git rm 的第 1 个附件）"
old=attachments/${ATTS[1]:t}
hist100() { for f in ${ATTS[1,100]}; do echo "HEAD~1:attachments/${f:t}"; done }
hist100p() { for f in ${ATTS[1,100]}; do echo "HEAD~1:attachments/${f:t} attachments/${f:t}"; done }  # --filters 需要 path
for r in plain lfs; do
  ( cd $r
    echo "[$r] --batch 头部: $(echo "HEAD~1:$old" | git cat-file --batch | head -c 220 | LC_ALL=C tr -c '[:print:]\n' '.' | head -4 | tr '\n' '|')"
    s=$EPOCHREALTIME; n=$(hist100 | git cat-file --batch | wc -c | tr -d ' ')
    printf '[%s] 100 个历史附件 --batch: %.0f ms, %s 字节\n' $r $(( (EPOCHREALTIME-s)*1000 )) $n
    s=$EPOCHREALTIME; n=$(hist100p | git cat-file --batch --filters | wc -c | tr -d ' ')
    printf '[%s] 100 个历史附件 --batch --filters: %.0f ms, %s 字节\n' $r $(( (EPOCHREALTIME-s)*1000 )) $n
    hdr=$(echo "HEAD~1:$old $old" | git cat-file --batch --filters | head -1)
    all=$(echo "HEAD~1:$old $old" | git cat-file --batch --filters | wc -c)
    echo "[$r] --batch --filters 头部: $hdr；实际正文字节: $(( all - ${#hdr} - 2 ))"
    echo "[$r] --batch --filters 不带 path: $(echo "HEAD~1:$old" | git cat-file --batch --filters 2>&1 >/dev/null | head -1)"
  )
done
( cd lfs
  echo "[lfs] git show HEAD~1:<path> 字节数: $(git show HEAD~1:$old | wc -c | tr -d ' ')（不走 smudge）"
  echo "[lfs] git cat-file --filters HEAD~1:<path> 字节数: $(git cat-file --filters HEAD~1:$old | wc -c | tr -d ' ')"
  echo "[lfs] 指针 | git lfs smudge 字节数: $(git cat-file blob HEAD~1:$old | git lfs smudge | wc -c | tr -d ' ')"
  oid=$(git cat-file blob HEAD~1:$old | sed -n 's/^oid sha256://p')
  echo "[lfs] 指针 oid 前缀 ${oid[1,16]} vs sha256(内容) $(shasum -a 256 $ATTS[1] | cut -c1-16)；.git/lfs/objects/${oid[1,2]}/${oid[3,4]}/<oid> 存在: $([[ -f .git/lfs/objects/${oid[1,2]}/${oid[3,4]}/$oid ]] && echo yes || echo no)"
)
( cd c-lfs
  oid=$(git cat-file blob HEAD~1:$old | sed -n 's/^oid sha256://p')
  echo "[有 lfs 的 clone] 历史附件的本地 LFS 对象存在: $([[ -f .git/lfs/objects/${oid[1,2]}/${oid[3,4]}/$oid ]] && echo yes || echo no)"
  s=$EPOCHREALTIME; n=$(git cat-file --filters HEAD~1:$old 2>/dev/null | wc -c | tr -d ' ')
  printf '[有 lfs 的 clone] cat-file --filters 读历史附件: %s 字节, %.0f ms\n' $n $(( (EPOCHREALTIME-s)*1000 ))
  echo "[有 lfs 的 clone] 之后本地对象存在: $([[ -f .git/lfs/objects/${oid[1,2]}/${oid[3,4]}/$oid ]] && echo yes || echo no)"
)
( cd c-lfs-nolfs
  echo "[无 lfs clone] cat-file --filters: $(PATH=$NOLFS_PATH git cat-file --filters HEAD~1:$old | wc -c | tr -d ' ') 字节（无 filter 配置 → 原样输出指针）" )
( cd c-partial
  s=$EPOCHREALTIME; n=$(git cat-file -p HEAD~1:$old | wc -c | tr -d ' ')
  printf '[partial clone] 读一个历史附件（按需从 remote 拉取）: %s 字节, %.0f ms\n' $n $(( (EPOCHREALTIME-s)*1000 ))
  s=$EPOCHREALTIME; hist100 | git cat-file --batch >/dev/null
  printf '[partial clone] 再读 100 个历史附件 --batch（逐个按需拉取）: %.0f ms, 之后 .git %s\n' $(( (EPOCHREALTIME-s)*1000 )) "$(size .git)" )

echo "\n== 从历史恢复缺失附件（#9 决定 7）"
( cd c-lfs && git restore --source=HEAD~1 -- $old && echo "[有 lfs] git restore --source=HEAD~1 写回: $(wc -c < $old | tr -d ' ') 字节（经过 smudge，得到真实内容）"; rm -f $old )
( cd c-lfs-nolfs && PATH=$NOLFS_PATH git restore --source=HEAD~1 -- $old && echo "[无 lfs] git restore 写回: $(wc -c < $old | tr -d ' ') 字节（指针）"; rm -f $old )

echo "\n== 离线 / remote 不可达时读未下载的 LFS 对象"
rm -rf c-lfs-offline; cp -R c-lfs-skip c-lfs-offline
( set +e; cd c-lfs-offline && git remote set-url origin file:///nonexistent
  p2=attachments/${ATTS[2]:t}
  printf 'HEAD~1:%s %s\nHEAD~1:%s %s\n' $old $old $p2 $p2 | git cat-file --batch --filters > out.bin 2>err.txt; rc=$pipestatus[2]
  echo "cat-file --batch --filters 退出码 $rc，stdout $(wc -c < out.bin | tr -d ' ') 字节；stderr: $(head -c 200 err.txt | tr '\n' ' ')"
  git cat-file blob HEAD~1:$old | git lfs smudge -- $old > out.bin 2>err.txt; rc=$pipestatus[2]
  echo "git lfs smudge 退出码 $rc，输出 $(wc -c < out.bin | tr -d ' ') 字节；stderr: $(head -c 200 err.txt | tr '\n' ' ')"
  git restore --source=HEAD~1 -- $old 2>err.txt; rc=$?
  echo "git restore 退出码 $rc，写回 $(wc -c < $old 2>/dev/null | tr -d ' ') 字节；stderr: $(head -c 200 err.txt | tr '\n' ' ')" )
