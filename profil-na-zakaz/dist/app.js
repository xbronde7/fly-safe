'use strict';
const products = {
 profiles: [
  { id: 'u', name: 'П-образный профиль', brief: 'Для каркасов, направляющих и монтажных конструкций', description: 'Профиль с П-образным сечением для каркасов, направляющих и других конструкций. Укажите размеры полок, основания, длину и толщину металла — проверим возможность изготовления и подготовим расчёт.', category: 'Профиль на заказ' },
  { id: 'z', name: 'Z-образный профиль', brief: 'Для крепления, обрешётки и соединения элементов', description: 'Профиль с разнонаправленными полками. Подходит для соединения и крепления элементов конструкции. Изготовление по вашим размерам: ширина полок, высота стенки, длина и толщина согласуются по эскизу.', category: 'Профиль на заказ' },
  { id: 'l', name: 'Уголок', brief: 'Для примыканий, отделки и крепления', description: 'Гнутый металлический уголок с полками нужной ширины. Для отделки, примыканий и конструктивных задач. Укажите длину, размеры полок, угол гиба и материал.', category: 'Профиль на заказ' },
  { id: 'omega', name: 'Шляпный профиль', brief: 'Для фасадов, кровли и металлической обрешётки', description: 'Шляпный, или омега-профиль, используют как несущую планку для вентилируемых фасадов и металлическую обрешётку. Изготовим по вашему эскизу с согласованными параметрами.', category: 'Профиль на заказ' }
 ],
 facade: [
  { id: 'cassette', name: 'Фасадные кассеты', brief: 'Облицовочные панели по размерам проекта', description: 'Металлические фасадные кассеты по индивидуальным размерам для облицовки зданий. Для расчёта укажите габариты панели, материал, цвет и количество.', category: 'Фасадные элементы' },
  { id: 'l', name: 'Доборные элементы', brief: 'Углы, планки и элементы примыканий', description: 'Доборные элементы для завершения отделки фасадов и кровли. Отправьте эскиз с размерами, желаемый материал, цвет и количество изделий.', category: 'Фасадные элементы' },
  { id: 'custom', name: 'Металлический сайдинг', brief: 'Металлическая облицовка для вашего фасада', description: 'Изготовление металлического сайдинга по параметрам проекта. Возможность изготовления конкретной формы, материал, покрытие и объём уточняются при расчёте.', category: 'Фасадные элементы' },
  { id: 'omega', name: 'Фасадный профиль', brief: 'Для подсистем и крепления облицовки', description: 'Профили для монтажа фасадных элементов по чертежу заказчика. Укажите сечение, размеры, материал и количество. Проверим возможность изготовления вашей детали.', category: 'Фасадные элементы' }
 ],
 perforation: [
  { id: 'perforated', name: 'Перфорированный лист', brief: 'Отверстия и рисунок под вашу задачу', description: 'Перфорация листового металла по вашему эскизу. Для расчёта нужны размеры листа, материал, толщина, форма и расположение отверстий, количество деталей.', category: 'Перфорированное изделие' },
  { id: 'perforated', name: 'Вентиляционные решётки', brief: 'Для движения воздуха и аккуратной отделки', description: 'Металлические вентиляционные решётки по индивидуальным размерам. Уточним габариты, вид перфорации, материал и требуемое исполнение.', category: 'Перфорированное изделие' },
  { id: 'perforated', name: 'Экраны для радиаторов', brief: 'Декоративные панели для интерьера', description: 'Плоские панели для радиаторов в нишах и объёмные экраны по вашим размерам. Можно согласовать рисунок перфорации и цвет порошковой покраски.', category: 'Перфорированное изделие' },
  { id: 'cassette', name: 'Корзины для кондиционеров', brief: 'Металлические конструкции для фасада', description: 'Корзины для кондиционеров по параметрам проекта. Укажите габариты блока, размеры конструкции, материал и пожелания к перфорации и цвету.', category: 'Перфорированное изделие' }
 ],
 custom: [
  { id: 'custom', name: 'По вашему чертежу', brief: 'Нестандартная форма и индивидуальные размеры', description: 'Начнём с вашей задачи. Подготовьте чертёж или эскиз, укажите материал, толщину и количество. Оценим возможность изготовления, предложим решение и рассчитаем стоимость.', category: 'Нестандартное изделие / услуга' },
  { id: 'l', name: 'Резка и гибка', brief: 'Обработка листа по согласованным параметрам', description: 'Резка и гибка листового металла. Укажите материал, толщину, размеры заготовки, линии гиба и количество. Возможность обработки зависит от геометрии детали.', category: 'Нестандартное изделие / услуга' },
  { id: 'perforated', name: 'Декоративные элементы', brief: 'Металлические панели и изделия для интерьера', description: 'Декоративные металлические элементы по вашим эскизам: панели, экраны и облицовка. Покажите идею, укажите размеры и назначение — обсудим исполнение.', category: 'Нестандартное изделие / услуга' },
  { id: 'cassette', name: 'Кабельные лотки', brief: 'Для прокладки и организации кабелей', description: 'Металлические кабельные каналы и лотки по размерам заказчика. Укажите сечение, длину, материал, наличие перфорации и количество изделий.', category: 'Нестандартное изделие / услуга' }
 ]
};
let currentProducts = products.profiles;
const grid = document.querySelector('#product-grid');
const productDialog = document.querySelector('#product-dialog');
let selectedProduct = '';
let currentStep = 1;
const quoteForm = document.querySelector('#quote-form');

function renderProducts(category) {
 currentProducts = products[category];
 grid.replaceChildren(...currentProducts.map((product, index) => {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'product-card';
  button.setAttribute('aria-label', `${product.name} — подробнее`);
  button.innerHTML = `<span class="product-number">0${index + 1} /</span><span class="product-arrow" aria-hidden="true">↗</span><div class="product-card-image"><img src="assets/${product.id}.svg" alt="Схематичное изображение: ${product.name.toLowerCase()}" width="600" height="500" loading="lazy"></div><div class="product-card-copy"><h3>${product.name}</h3><p>${product.brief}</p></div>`;
  button.addEventListener('click', () => openProduct(product));
  return button;
 }));
}
renderProducts('profiles');

document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
 document.querySelectorAll('[data-filter]').forEach(tab => { tab.classList.toggle('active', tab === button); tab.setAttribute('aria-pressed', String(tab === button)); });
 renderProducts(button.dataset.filter);
}));

const shapeNames = { u: 'П-образный профиль', z: 'Z-образный профиль', l: 'Уголок' };
document.querySelectorAll('[data-shape]').forEach((button, index) => button.addEventListener('click', () => {
 document.querySelectorAll('[data-shape]').forEach(tab => { tab.classList.toggle('active', tab === button); tab.setAttribute('aria-pressed', String(tab === button)); });
 const image = document.querySelector('#hero-product');
 image.src = `assets/${button.dataset.shape}.svg`; image.alt = `Объёмная схема: ${shapeNames[button.dataset.shape]}`;
 document.querySelector('#hero-caption').textContent = shapeNames[button.dataset.shape];
 document.querySelector('.visual-index').textContent = `0${index + 1} / 03`;
 document.querySelector('.visual-sub').textContent = `0${index + 1}`;
}));

function openProduct(product) {
 document.querySelector('#dialog-title').textContent = product.name;
 document.querySelector('#dialog-description').textContent = product.description;
 const image = document.querySelector('#dialog-image'); image.src = `assets/${product.id}.svg`; image.alt = `Схема: ${product.name}`;
 document.querySelector('#dialog-order').onclick = () => { selectOrderProduct(product.category, product.name); productDialog.close(); document.querySelector('#order').scrollIntoView({behavior:'smooth'}); };
 productDialog.showModal();
}

function selectOrderProduct(category, name) {
 quoteForm.reset();
 [...quoteForm.elements.category].find(input => input.value === category).checked = true;
 selectedProduct = name;
 quoteForm.elements.description.value = `Изделие / услуга: ${name}. `;
 document.querySelector('#quote-result').hidden = true; quoteForm.hidden = false; document.querySelector('.form-progress').hidden = false;
 showStep(2);
}

document.querySelectorAll('[data-service]').forEach(link => link.addEventListener('click', () => selectOrderProduct('Нестандартное изделие / услуга', link.dataset.service)));
document.querySelectorAll('.dialog-close').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => {
 if (event.target !== dialog) return;
 const box = dialog.getBoundingClientRect();
 if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
}));
document.querySelector('#privacy-button').addEventListener('click', () => document.querySelector('#privacy-dialog').showModal());

function validateStep() {
 const inputs = [...document.querySelector(`[data-step="${currentStep}"]`).querySelectorAll('input,select,textarea')];
 return inputs.every(input => input.reportValidity());
}
function showStep(step) {
 currentStep = step;
 document.querySelectorAll('[data-step]').forEach(fieldset => { fieldset.hidden = Number(fieldset.dataset.step) !== step; });
 document.querySelectorAll('[data-progress]').forEach(span => {
  const value = Number(span.dataset.progress); span.classList.toggle('current', value === step); span.classList.toggle('done', value < step);
  if (value === step) span.setAttribute('aria-current', 'step'); else span.removeAttribute('aria-current');
 });
 const note = document.querySelector('#selected-product-note'); note.hidden = !selectedProduct; note.textContent = selectedProduct ? `Выбрано: ${selectedProduct}` : '';
}
showStep(1);
document.querySelectorAll('.next-step').forEach(button => button.addEventListener('click', () => { if (validateStep()) { showStep(currentStep + 1); document.querySelector(`[data-step="${currentStep}"] input, [data-step="${currentStep}"] select`)?.focus({preventScroll:true}); } }));
document.querySelectorAll('.back-step').forEach(button => button.addEventListener('click', () => showStep(currentStep - 1)));
quoteForm.elements.category.forEach(input => input.addEventListener('change', () => { selectedProduct = ''; quoteForm.elements.description.value = ''; }));

let preparedBody = '';
quoteForm.addEventListener('submit', event => {
 event.preventDefault();
 if (currentStep < 3) { if (validateStep()) showStep(currentStep + 1); return; }
 if (!validateStep()) return;
 const data = new FormData(quoteForm);
 const lines = [
  'Здравствуйте! Прошу рассчитать изготовление.', '',
  `Направление: ${data.get('category')}`,
  ...(selectedProduct ? [`Изделие / услуга: ${selectedProduct}`] : []),
  `Материал: ${data.get('material')}`,
  `Количество: ${data.get('quantity') ? data.get('quantity') + ' шт.' : 'нужно уточнить'}`,
  `Длина: ${data.get('length') ? data.get('length') + ' мм' : 'нужно уточнить'}`,
  `Толщина: ${data.get('thickness') ? data.get('thickness') + ' мм' : 'нужно уточнить'}`,
  ...(data.get('description').trim() ? ['', `Описание: ${data.get('description').trim()}`] : []), '',
  `Имя: ${data.get('name').trim()}`, `Email: ${data.get('email').trim()}`,
  ...(data.get('phone').trim() ? [`Телефон: ${data.get('phone').trim()}`] : [])
 ];
 preparedBody = lines.join('\n');
 document.querySelector('#quote-summary').textContent = preparedBody;
 document.querySelector('#send-email').href = `mailto:profil@uralprom-impex.ru?subject=${encodeURIComponent('Заявка на расчёт: ' + (selectedProduct || data.get('category')))}&body=${encodeURIComponent(preparedBody)}`;
 quoteForm.hidden = true; document.querySelector('#quote-result').hidden = false;
 document.querySelector('.form-progress').hidden = true;
 document.querySelector('#send-email').focus({preventScroll:true});
});
document.querySelector('#edit-request').addEventListener('click', () => { quoteForm.hidden = false; document.querySelector('#quote-result').hidden = true; document.querySelector('.form-progress').hidden = false; showStep(2); });
document.querySelector('#download-request').addEventListener('click', () => {
 const url = URL.createObjectURL(new Blob(['\uFEFF' + preparedBody], {type:'text/plain;charset=utf-8'}));
 const link = document.createElement('a'); link.href = url; link.download = 'Заявка-Уралпром-Импекс.txt'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
const menuToggle = document.querySelector('.menu-toggle');
const mobileNav = document.querySelector('#mobile-nav');
menuToggle.addEventListener('click', () => { const open = menuToggle.getAttribute('aria-expanded') !== 'true'; menuToggle.setAttribute('aria-expanded', String(open)); menuToggle.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню'); mobileNav.hidden = !open; });
mobileNav.querySelectorAll('a').forEach(link => link.addEventListener('click', () => { mobileNav.hidden = true; menuToggle.setAttribute('aria-expanded','false'); menuToggle.setAttribute('aria-label','Открыть меню'); }));
document.addEventListener('keydown', event => { if(event.key === 'Escape' && !mobileNav.hidden){mobileNav.hidden=true;menuToggle.setAttribute('aria-expanded','false');menuToggle.setAttribute('aria-label','Открыть меню');menuToggle.focus();} });
