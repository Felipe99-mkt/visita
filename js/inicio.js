// Tela inicial: monta os cartões a partir de projetos.js e leva ao visualizador.
import { PROJETOS } from './projetos.js';

const lista = document.getElementById('lista');
const seta = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

lista.classList.toggle('unico', PROJETOS.length === 1);
document.getElementById('contagem').textContent =
  PROJETOS.length === 1 ? '1 projeto' : `${PROJETOS.length} projetos`;

for (const p of PROJETOS) {
  const a = document.createElement('a');
  a.className = 'cartao';
  a.href = p.link;
  a.setAttribute('aria-label', `Entrar no projeto ${p.nome}`);

  const capa = document.createElement('div');
  capa.className = 'capa';
  const img = new Image();
  img.src = p.capa; img.alt = ''; img.decoding = 'async';
  img.onload = () => capa.classList.add('carregada');
  capa.append(img);

  const info = document.createElement('div');
  info.className = 'info';
  const textos = document.createElement('div');
  const rotulo = document.createElement('span'); rotulo.className = 'rotulo'; rotulo.textContent = p.rotulo;
  const nome = document.createElement('h3'); nome.textContent = p.nome;
  textos.append(rotulo, nome);
  const botao = document.createElement('span');
  botao.className = 'entrar';
  botao.innerHTML = `<span>Entrar no projeto</span>${seta}`;
  info.append(textos, botao);

  a.append(capa, info);
  // saída suave antes de abrir o visualizador
  a.addEventListener('click', e => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    document.body.classList.add('saindo');
    setTimeout(() => { location.href = p.link; }, 280);
  });
  lista.append(a);
}

// voltar com o botão "voltar" do navegador não pode deixar a página apagada
addEventListener('pageshow', () => document.body.classList.remove('saindo'));
