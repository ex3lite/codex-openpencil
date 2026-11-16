// Native, linked controls. Interaction runs in PreviewSession, never a web overlay.
const fill=color=>[{type:'solid',color}];
const text=(id,content,x,y,size=16,color='$brush-ink')=>({type:'text',id,name:content,x,y,width:1100,height:size*1.5,content,fontFamily:'Inter',fontSize:size,lineHeight:1.3,fill:fill(color)});
const state=(value,type='bool')=>({type,default:value});
export function buttonState(overrides={}) {
 return {hovered:state(false),pressed:state(false),focused:state(false),disabled:state(false),...overrides};
}
export function designSystemPreset({accent='#0071E3',fontFamily='Inter',prefix='brush'}={}) {
 if(prefix!=='brush')throw Error('Unsupported design-system namespace');
 if(!/^#[0-9a-f]{6}$/i.test(accent))throw Error('Accent must be a six-digit hex color');
 if(typeof fontFamily!=='string'||!fontFamily.trim()||fontFamily.length>100)throw Error('Invalid font family');
 const tokens={
  'brush-accent':{type:'color',value:accent},'brush-surface':{type:'color',value:'#FFFFFF'},
  'brush-canvas':{type:'color',value:'#F5F5F7'},'brush-ink':{type:'color',value:'#1D1D1F'},
  'brush-muted':{type:'color',value:'#6E6E73'},'brush-border':{type:'color',value:'#D2D2D7'},
  'brush-type-control':{type:'number',value:500},'brush-type-body':{type:'number',value:400},
  'brush-type-title':{type:'number',value:600},'brush-space-2':{type:'number',value:8},
  'brush-space-6':{type:'number',value:24}
 };
 const set=(name,value)=>[{set:{['$self.'+name]:String(value)}}];
 const button=(id,secondary=false)=>({type:'frame',id,name:secondary?'Button / Secondary':'Button / Primary',reusable:true,width:190,height:50,
  layout:'horizontal',padding:[0,16],alignItems:'center',justifyContent:'center',cornerRadius:25,
  fill:fill(secondary?'$brush-surface':'$brush-accent'),stroke:{fill:fill(secondary?'$brush-border':accent),thickness:2},
  state:buttonState(),enabled:'!$self.disabled',semantics:{role:'button',label:'Открыть редактор',disabled:'$self.disabled'},
  bindings:{opacity:'$self.disabled ? 0.35 : $self.pressed ? 0.78 : $self.hovered ? 0.94 : 1',
   stroke:secondary ? "$self.focused ? $vars['brush-accent'] : $vars['brush-border']" : "$self.focused ? $vars['brush-ink'] : $vars['brush-accent']"},
  events:{onHoverEnter:set('hovered',true),onHoverLeave:set('hovered',false),onPressStart:set('pressed',true),onPressEnd:set('pressed',false),onPressCancel:set('pressed',false),onFocus:set('focused',true),onBlur:set('focused',false)},
  transition:{durationMs:150,easing:'ease_out',properties:['opacity','stroke']},
  children:[{...text(id+'-label','Открыть редактор',undefined,undefined,15,secondary?'$brush-accent':'$brush-surface'),width:'fill_container',height:'fit_content',textAlign:'center',fontWeight:'$brush-type-control',textGrowth:'auto',fontFamily}]
 });
 const primary=button('brush-button-primary'),secondary=button('brush-button-secondary',true);
 // Distinct focus indication changes opacity without moving solved geometry.
 primary.bindings.opacity='$self.disabled ? 0.35 : $self.pressed ? 0.78 : $self.focused ? 0.86 : $self.hovered ? 0.94 : 1';
 const input={type:'frame',id:'brush-field',name:'Field / Text',reusable:true,width:320,height:50,children:[{type:'text_input',id:'brush-field-input',width:320,height:50,placeholder:'Электронная почта',cornerRadius:12,fill:fill('$brush-surface'),stroke:{fill:fill('$brush-border'),thickness:1},
  semantics:{label:'Электронная почта'},states:{hover:{stroke:{fill:fill('$brush-muted'),thickness:1}},pressed:{opacity:.9},focused:{stroke:{fill:fill('$brush-accent'),thickness:2}},disabled:{opacity:.35}},transition:{durationMs:150,easing:'ease_out',properties:['stroke','opacity']}}]};
 const card={type:'frame',id:'brush-card',name:'Card / Surface',reusable:true,width:320,height:144,cornerRadius:24,fill:fill('$brush-surface'),padding:'$brush-space-6',layout:'vertical',gap:'$brush-space-2',children:[{...text('brush-card-title','Продумано до деталей',undefined,undefined,20),width:'fill_container',height:28,fontWeight:'$brush-type-title'},{...text('brush-card-body','Один компонент — во всём проекте.',undefined,undefined,14,'$brush-muted'),width:'fill_container',height:44}]};
 const foundations={type:'frame',id:'brush-foundations',name:'01 · Основы',width:1280,height:930,fill:fill('$brush-canvas'),children:[text('brush-foundations-title','OpenBrush / Дизайн-система',64,52,40),text('brush-foundations-subtitle','Общие решения. Связанные компоненты. Проверяемые состояния.',64,118,18,'$brush-muted'),text('brush-colors-title','Цвет и контраст',64,192,24)]};
 const colors=['accent','surface','ink','muted','border'];
 colors.forEach((key,i)=>foundations.children.push({type:'rectangle',id:'brush-swatch-'+key,name:'Color / '+key,x:64+i*232,y:244,width:208,height:104,cornerRadius:16,fill:fill('$brush-'+key)},text('brush-swatch-label-'+key,key,64+i*232,362,14,'$brush-muted')));
 foundations.children.push(text('brush-type-title','Типографика',64,438,24),text('brush-type-display','Хороший дизайн работает как система.',64,490,36),text('brush-type-body',fontFamily+' · Кириллица, латиница и числа 0123456789',64,552,18,'$brush-muted'),text('brush-space-title','Ритм / 8 · 16 · 24 · 32 · 48 · 64',64,646,24),text('brush-motion-title','Движение / 150 мс · ease-out',64,740,24),text('brush-motion-body','Наведение, нажатие и фокус — без сдвига раскладки. Reduced motion отключает переходы.',64,794,16,'$brush-muted'));
 const kit={type:'frame',id:'brush-ui-kit',name:'02 · UI Kit',width:1280,height:1160,fill:fill('$brush-canvas'),children:[text('brush-kit-title','Компоненты, а не копии',64,52,40),text('brush-kit-subtitle','Выберите экземпляр и измените мастер. Для взаимодействий включите прототип.',64,118,18,'$brush-muted')]};
 primary.x=64;primary.y=228;secondary.x=304;secondary.y=228;input.x=64;input.y=810;card.x=520;card.y=810;
 kit.children.push(text('brush-masters-title','Мастера',64,176,20),primary,secondary,text('brush-states-title','Состояния / Button',64,336,24));
 ['default','hover','pressed','focused','disabled'].forEach((mode,i)=>{
  const flags=buttonState();if(mode!=='default')flags[mode==='hover'?'hovered':mode]=state(true);
  const opacity={default:1,hover:.94,pressed:.78,focused:.86,disabled:.35}[mode];
  kit.children.push({type:'ref',id:'brush-button-'+mode,ref:primary.id,x:64+i*232,y:402,name:'Button / '+mode,descendants:{[primary.id]:{state:flags,opacity,...(mode==='focused'?{stroke:{fill:fill('$brush-ink'),thickness:2}}:{})}}},text('brush-mode-'+mode,mode,64+i*232,470,14,'$brush-muted'));
 });
 kit.children.push(text('brush-rules-title','Правила использования',64,566,24),text('brush-rules-body','Цвет меняется через переменные. Размер и текст — через overrides экземпляра.\nНе отсоединять кнопки ради локальной правки. Не анимировать ширину или положение раскладки.',64,616,16,'$brush-muted'),text('brush-fields-title','Поле и карточка',64,742,24),input,card);
 const stack=[foundations,kit];while(stack.length){const node=stack.pop();if(node.type==='text'){node.fontFamily=fontFamily;if(node.fontWeight===undefined)node.fontWeight=node.fontSize>=24?'$brush-type-title':'$brush-type-body';}stack.push(...(node.children||[]));}
 return {tokens,pages:[{id:'brush-foundations-page',name:'01 · Дизайн-система',children:[foundations]},{id:'brush-kit-page',name:'02 · UI Kit',children:[kit]}],components:[primary.id,secondary.id,input.id,card.id]};
}

export function newDesignDocument(){
 const {tokens,pages}=designSystemPreset();
 return {version:'0.8.5',name:'Новый проект',variables:tokens,children:[],pages:[{id:'0',name:'Макеты',children:[]},...pages]};
}
