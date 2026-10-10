/* eslint-disable react/jsx-no-bind, react/jsx-no-literals */
import React from 'react';
import {MenuItem} from '../components/menu/menu.jsx';

const CollaborationMenuItem = () => {
    const handleClick = () => {
        window.dispatchEvent(new CustomEvent('nyaitter-open-collaboration'));
    };
    return <MenuItem onClick={handleClick}>共同作業</MenuItem>;
};

export default CollaborationMenuItem;
