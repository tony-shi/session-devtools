# start

  cd /Users/shihuashen/Documents/session-dashboard/docs
  PATH=/opt/homebrew/opt/ruby/bin:$PATH bundle exec jekyll serve \
    --host 127.0.0.1 \
    --port 4000 \
    --source . \
    --destination _site \
    --config _config.yml,_config.local.yml


# stop
lsof -ti :4000 | xargs kill