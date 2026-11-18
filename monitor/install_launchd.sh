#!/bin/zsh
# 맥미니에서 차량 모니터 서버를 로그인 시 자동 실행 + 죽으면 다시 켜지도록 등록 (launchd)
# 사용: ~/Desktop/tesla-speed-alarm/monitor/install_launchd.sh      (해제: ... --uninstall)
set -e
LABEL=com.jhpark.tesla-monitor
PLIST=~/Library/LaunchAgents/$LABEL.plist
LOG=~/.config/tesla-monitor/server.log
DIR=${0:A:h}

if [[ "$1" == "--uninstall" ]]; then
  launchctl bootout gui/$(id -u)/$LABEL 2>/dev/null || true
  rm -f $PLIST; print "자동 실행 해제됨"; exit 0
fi

NODE=$(command -v node) || { print "node가 없습니다. 먼저 Node 22를 설치하세요 (brew install node)"; exit 1; }
mkdir -p ~/Library/LaunchAgents ~/.config/tesla-monitor
cat > $PLIST <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/server.mjs</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
EOF
launchctl bootout gui/$(id -u)/$LABEL 2>/dev/null || true
launchctl bootstrap gui/$(id -u) $PLIST
sleep 1
print "자동 실행 등록 완료. 로그: $LOG"
tail -3 $LOG
