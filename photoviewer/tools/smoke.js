(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  await sleep(1200);
  out.cells = document.querySelectorAll('.cell').length;
  out.title = document.querySelector('#title').textContent;
  out.subtitle = document.querySelector('#subtitle').textContent;
  out.bannerHidden = document.querySelector('#banner').hidden;

  // 实况照片
  document.querySelector('.cell[data-id="2020/10/24/IMG_0956.JPG"]').click();
  await sleep(2200);
  const v = document.querySelector('#vLiveVid');
  out.live = {
    playing: v.classList.contains('on'),
    size: v.videoWidth + 'x' + v.videoHeight,
    err: v.error ? v.error.code : null,
    imgReady: document.querySelector('#vImg').classList.contains('ready'),
  };

  // 视频
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(400);
  document.querySelector('.cell[data-id="2024/04/30/IMG_5906.MOV"]').click();
  await sleep(2000);
  const vv = document.querySelector('#vVid');
  out.video = {
    src: vv.getAttribute('src'),
    size: vv.videoWidth + 'x' + vv.videoHeight,
    dur: vv.duration ? +vv.duration.toFixed(2) : null,
    err: vv.error ? vv.error.code : null,
    ready: vv.readyState,
  };
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return out;
})()
