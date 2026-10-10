import React from 'react';
import icon from './nyaitter-id-icon.png';

const NyaitterIdBadge = () => (<img
    src={icon}
    alt="NyaitterID認証済み"
    title="NyaitterID認証済み"
    width="14"
    height="14"
    style={{
        display: 'inline-block',
        width: 14,
        height: 14,
        marginLeft: 3,
        verticalAlign: 'text-bottom',
        borderRadius: 2
    }}
/>);

export default NyaitterIdBadge;
