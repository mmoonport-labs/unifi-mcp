#!/bin/sh
# Refresh a bundled spec.
#   scripts/update-spec.sh network 11.0.99
#   scripts/update-spec.sh protect 7.3.74
# Source: Ubiquiti's API docs CDN first (first-party, but it stops at Network 10.3.58 and the gateway is often newer), then the
# community repo beezly/unifi-apis, which extracts a spec from each controller release. Use your gateway's own version
# (unifi_info shows it). The spec's text reaches the model through the search and describe tools, so review the diff before you commit it.
set -eu
APP="${1:?usage: update-spec.sh network|protect <version>}"
VERSION="${2:?usage: update-spec.sh network|protect <version>}"
case "$APP" in
  network) FILE=integration.json; COMMUNITY="unifi-network/$VERSION.json" ;;
  protect) FILE=protect.json; COMMUNITY="unifi-protect/$VERSION.json" ;;
  *) echo "app must be network or protect" >&2; exit 1 ;;
esac
DIR="$(dirname "$0")/../spec"
TMP=$(mktemp)
if curl -fsS -m 30 -o "$TMP" "https://apidoc-cdn.ui.com/$APP/v$VERSION/integration.json" 2>/dev/null; then
  SOURCE="Ubiquiti's docs CDN"
elif curl -fsS -m 30 -o "$TMP" "https://raw.githubusercontent.com/beezly/unifi-apis/main/$COMMUNITY"; then
  SOURCE="community repo beezly/unifi-apis"
else
  echo "no spec for $APP $VERSION from either source" >&2; rm -f "$TMP"; exit 1
fi
node -e "
const fs=require('fs');const next=JSON.parse(fs.readFileSync(process.argv[1]));
const ops=d=>new Set(Object.entries(d.paths).flatMap(([p,i])=>Object.keys(i).filter(m=>['get','post','put','patch','delete'].includes(m)).map(m=>m.toUpperCase()+' '+p)));
let old=new Set();try{old=ops(JSON.parse(fs.readFileSync(process.argv[2])))}catch{}
const now=ops(next);
console.log('operations:',now.size,'added:',[...now].filter(x=>!old.has(x)),'removed:',[...old].filter(x=>!now.has(x)));
" "$TMP" "$DIR/$FILE"
mv "$TMP" "$DIR/$FILE"
if [ "$APP" = protect ]; then
  node -e "const f=process.argv[1];const v=JSON.parse(require('fs').readFileSync(f));v.protect=process.argv[2];require('fs').writeFileSync(f,JSON.stringify(v,null,2)+'\n')" "$DIR/versions.json" "$VERSION"
fi
echo "spec/$FILE is now $APP $VERSION from the $SOURCE. Run npm test and npm run build, then reconnect the MCP server (/mcp). Read 'git diff --stat spec'."
