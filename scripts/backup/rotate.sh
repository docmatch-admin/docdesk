#!/usr/bin/env bash
# เก็บไฟล์สำรองลง branch "backups" เหลือ 30 ไฟล์ล่าสุด
# ใช้: rotate.sh <ไฟล์สำรอง> <URL ของ repo>
set -euo pipefail

file="$1"
url="$2"
keep="${BACKUP_KEEP:-30}"
store="$(mktemp -d)"
trap 'rm -rf "$store"' EXIT

if git ls-remote --exit-code --heads "$url" backups >/dev/null 2>&1; then
  git clone --quiet --depth 1 --branch backups "$url" "$store"
else
  git -C "$store" init --quiet --initial-branch=backups
  git -C "$store" remote add origin "$url"
fi

mv "$file" "$store/"
cd "$store"
ls -1 docdesk-*.sql.gz.age | sort | head -n "-$keep" | xargs -r rm -f --

git config user.name "docdesk-backup"
git config user.email "backup@users.noreply.github.com"
# สร้างประวัติใหม่ commit เดียวทุกครั้ง ไฟล์ที่เกิน 30 วันจะไม่ค้างอยู่ใน history ของ branch
rm -rf .git/shallow
git symbolic-ref HEAD refs/heads/rotated
git rm -r -q --cached . >/dev/null 2>&1 || true
git add -A
git commit --quiet -m "Backup $(TZ=Asia/Bangkok date +%F)"
git push --quiet --force origin rotated:backups

echo "เก็บอยู่ $(ls -1 docdesk-*.sql.gz.age | wc -l) ไฟล์"
