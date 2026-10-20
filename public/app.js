// Signature pads: draw with finger/mouse, copy the PNG into the hidden input on submit.
for (const canvas of document.querySelectorAll('canvas[data-signature]')) {
  const name = canvas.dataset.signature;
  const input = canvas.parentElement.querySelector(`input[name="${name}"]`);
  const ctx = canvas.getContext('2d');
  let drawing = false;
  canvas.dataset.empty = 'true';

  const reset = () => {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    canvas.dataset.empty = 'true';
    input.value = '';
  };
  const point = (e) => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) * canvas.width) / r.width, ((e.clientY - r.top) * canvas.height) / r.height];
  };

  reset();
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#111';

  canvas.addEventListener('pointerdown', (e) => {
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    ctx.beginPath();
    ctx.moveTo(...point(e));
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    ctx.lineTo(...point(e));
    ctx.stroke();
    canvas.dataset.empty = 'false';
  });
  const end = () => {
    drawing = false;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  document.querySelector(`[data-clear="${name}"]`)?.addEventListener('click', reset);
}

// Thumbnail preview for each photo slot.
for (const input of document.querySelectorAll('.slot input[type=file]')) {
  input.addEventListener('change', () => {
    const img = input.parentElement.querySelector('img');
    const file = input.files[0];
    if (!file) {
      img.hidden = true;
      return;
    }
    img.src = URL.createObjectURL(file);
    img.hidden = false;
    input.parentElement.classList.add('done');
  });
}

const form = document.querySelector('form.inspect');
form?.addEventListener('submit', (e) => {
  const hasPhoto = [...form.querySelectorAll('input[type=file]')].some((i) => i.files.length);
  if (!hasPhoto) {
    e.preventDefault();
    alert(form.dataset.errPhotos);
    return;
  }
  for (const canvas of form.querySelectorAll('canvas[data-signature]')) {
    if (canvas.dataset.empty === 'true') {
      e.preventDefault();
      alert(form.dataset.errSignatures);
      return;
    }
    canvas.parentElement.querySelector('input[type=hidden]').value = canvas.toDataURL('image/png');
  }
  form.querySelector('button.big').disabled = true;
});

document.querySelector('[data-print]')?.addEventListener('click', () => window.print());
